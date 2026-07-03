// OAuth2 for QuickBooks Online, using the official `intuit-oauth` package for
// the token dance only. Token lifecycle (critical):
//   - access token: 60 minutes
//   - refresh token: 100-day rolling window, but its VALUE rotates ~every 24h.
//     After EVERY refresh we atomically overwrite tokens.json with the newest
//     refresh token — losing a rotated value strands the session.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import OAuthClient from "intuit-oauth";
import type { IntuitAuthResponse, IntuitTokenJson } from "intuit-oauth";
import {
  ENV_FILE,
  OAUTH_CALLBACK_PORT,
  REDIRECT_URI,
  TOKENS_FILE,
  getClientId,
  getClientSecret,
  getEnvironment,
} from "./config.js";
import { CliError, outputOk } from "./output.js";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  environment: string;
  realm_id?: string;
  access_token_expires_at: string; // ISO
  refresh_token_expires_at: string; // ISO (100-day rolling window)
  obtained_at: string; // first successful auth
  refreshed_at: string; // last time tokens.json was (re)written from Intuit
}

// ---------------------------------------------------------------- persistence

export function loadTokens(): StoredTokens | null {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, "utf-8")) as StoredTokens;
  } catch {
    return null;
  }
}

/** Atomic write (tmp file + rename) with 0600 perms — never lose a rotated refresh token. */
function saveTokens(tokens: StoredTokens): void {
  const tmp = `${TOKENS_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, TOKENS_FILE);
  chmodSync(TOKENS_FILE, 0o600);
}

function tokenJsonFrom(resp: IntuitAuthResponse, client: OAuthClient): IntuitTokenJson {
  try {
    if (typeof resp?.getJson === "function") {
      const j = resp.getJson();
      if (j?.access_token) return j;
    }
  } catch {
    /* fall through */
  }
  if (resp?.json?.access_token) return resp.json;
  try {
    if (typeof resp?.getToken === "function") {
      const j = resp.getToken();
      if (j?.access_token) return j;
    }
  } catch {
    /* fall through */
  }
  if (resp?.token?.access_token) return resp.token;
  const t = client.getToken();
  if (t?.access_token) return t;
  throw new CliError("Could not read tokens from the Intuit OAuth response.", "TOKEN_PARSE");
}

function persistTokenResponse(
  json: IntuitTokenJson,
  prev?: StoredTokens | null,
  realmId?: string
): StoredTokens {
  if (!json.refresh_token) {
    throw new CliError("Intuit response contained no refresh_token.", "TOKEN_PARSE");
  }
  const now = Date.now();
  const stored: StoredTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? "bearer",
    environment: getEnvironment(),
    realm_id: realmId ?? json.realmId ?? prev?.realm_id,
    access_token_expires_at: new Date(now + (json.expires_in ?? 3600) * 1000).toISOString(),
    refresh_token_expires_at: new Date(
      now + (json.x_refresh_token_expires_in ?? 8_640_000) * 1000
    ).toISOString(),
    obtained_at: prev?.obtained_at ?? new Date(now).toISOString(),
    refreshed_at: new Date(now).toISOString(),
  };
  saveTokens(stored);
  return stored;
}

// ------------------------------------------------------------------- client

function buildOAuthClient(): OAuthClient {
  return new OAuthClient({
    clientId: getClientId(),
    clientSecret: getClientSecret(),
    environment: getEnvironment(),
    redirectUri: REDIRECT_URI,
    logging: false,
  });
}

// ------------------------------------------------------------------ refresh

/** Refresh now, persisting the rotated refresh token. Throws CliError on failure. */
export async function refreshTokens(): Promise<StoredTokens> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new CliError("Not authenticated. Run: quickbooks-cli auth", "NOT_AUTHENTICATED");
  }
  if (Date.parse(tokens.refresh_token_expires_at) <= Date.now()) {
    throw new CliError(
      "Refresh token expired (the 100-day rolling window lapsed). Re-run: quickbooks-cli auth",
      "REFRESH_TOKEN_EXPIRED"
    );
  }
  const client = buildOAuthClient();
  let resp: IntuitAuthResponse;
  try {
    resp = await client.refreshUsingToken(tokens.refresh_token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Token refresh failed: ${msg}. If the refresh token is dead, re-run: quickbooks-cli auth`,
      "REFRESH_FAILED"
    );
  }
  return persistTokenResponse(tokenJsonFrom(resp, client), tokens);
}

/**
 * Valid access token for API calls, transparently refreshing when expired or
 * within 60s of expiry (access tokens live 60 minutes).
 */
export async function getValidAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new CliError("Not authenticated. Run: quickbooks-cli auth", "NOT_AUTHENTICATED");
  }
  if (Date.parse(tokens.access_token_expires_at) - Date.now() < 60_000) {
    return (await refreshTokens()).access_token;
  }
  return tokens.access_token;
}

// ---------------------------------------------------------------- auth flow

interface CallbackResult {
  code: string;
  realmId?: string;
  callbackUrl: string; // path + query, as intuit-oauth's createToken() expects
}

function waitForCallback(state: string, authUrl: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${OAUTH_CALLBACK_PORT}`);
      if (u.pathname === "/favicon.ico") {
        res.writeHead(404);
        res.end();
        return;
      }
      const error = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        finish(() => reject(new CliError(`Intuit returned OAuth error: ${error}`, "OAUTH_DENIED")));
        return;
      }
      if (!code) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("quickbooks-cli: waiting for the OAuth callback...");
        return;
      }
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1><p>Possible CSRF — restart the auth flow.</p>");
        finish(() => reject(new CliError("OAuth state mismatch.", "STATE_MISMATCH")));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authenticated with QuickBooks</h1><p>You can close this window and return to the terminal.</p>"
      );
      finish(() =>
        resolve({
          code,
          realmId: u.searchParams.get("realmId") ?? undefined,
          callbackUrl: req.url ?? "",
        })
      );
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(new CliError("Timed out after 5 minutes waiting for the OAuth callback.", "AUTH_TIMEOUT"))
      );
    }, 300_000);

    server.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === "EADDRINUSE"
            ? new CliError(
                `Port ${OAUTH_CALLBACK_PORT} is already in use — is another auth flow running?`,
                "PORT_IN_USE"
              )
            : err
        )
      );
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {
      process.stderr.write(
        `\nOpen this URL in a browser and sign in as a QBO admin for the target company:\n\n${authUrl}\n\nWaiting for the callback on ${REDIRECT_URI} ...\n`
      );
      if (process.platform === "darwin") {
        try {
          spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* URL was printed; opening the browser is best-effort */
        }
      }
    });
  });
}

/** Offer to persist the callback's realmId into .env when QB_REALM_ID is unset. */
async function maybeWriteRealmToEnv(realmId?: string): Promise<void> {
  if (!realmId) return;
  if (process.env.QB_REALM_ID) {
    if (process.env.QB_REALM_ID !== realmId) {
      process.stderr.write(
        `Note: the OAuth callback's realmId (${realmId}) differs from QB_REALM_ID in .env (${process.env.QB_REALM_ID}). Commands keep using the .env value.\n`
      );
    }
    return;
  }
  let write = false;
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(
      `QB_REALM_ID is not set. Write QB_REALM_ID=${realmId} to ${ENV_FILE}? [Y/n] `
    );
    rl.close();
    write = !/^n/i.test(answer.trim());
  } else {
    process.stderr.write(
      `QB_REALM_ID is unset — add QB_REALM_ID=${realmId} to ${ENV_FILE}. (The realm was also saved in tokens.json as a fallback.)\n`
    );
  }
  if (!write) return;
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";
  if (/^QB_REALM_ID=\s*$/m.test(existing)) {
    writeFileSync(ENV_FILE, existing.replace(/^QB_REALM_ID=\s*$/m, `QB_REALM_ID=${realmId}`));
  } else {
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(ENV_FILE, `${sep}QB_REALM_ID=${realmId}\n`);
  }
  process.stderr.write(`Wrote QB_REALM_ID=${realmId} to ${ENV_FILE}\n`);
}

function authSuccessData(stored: StoredTokens, message: string) {
  return {
    message,
    environment: stored.environment,
    realm_id: stored.realm_id ?? null,
    access_token_expires_at: stored.access_token_expires_at,
    refresh_token_expires_at: stored.refresh_token_expires_at,
    tokens_file: TOKENS_FILE,
  };
}

/** Interactive OAuth: localhost:3456 callback server + browser handshake. */
export async function runAuthFlow(): Promise<void> {
  const client = buildOAuthClient();
  const state = randomBytes(16).toString("hex");
  const authUrl = client.authorizeUri({ scope: [OAuthClient.scopes.Accounting], state });
  const { realmId, callbackUrl } = await waitForCallback(state, authUrl);
  const resp = await client.createToken(callbackUrl);
  const stored = persistTokenResponse(tokenJsonFrom(resp, client), loadTokens(), realmId);
  await maybeWriteRealmToEnv(realmId);
  outputOk(
    authSuccessData(stored, "Authenticated"),
    () =>
      `Authenticated (${stored.environment}), realm ${stored.realm_id ?? "unknown"}.\nAccess token expires ${stored.access_token_expires_at}; refresh window ends ${stored.refresh_token_expires_at}.\nTokens saved to ${TOKENS_FILE} (0600).`
  );
}

/**
 * Complete auth from a pasted redirect URL — for production, where the
 * registered redirect URI must be public HTTPS (localhost is sandbox-only).
 * Set QB_REDIRECT_URI to the hosted callback before authorizing.
 */
export async function completeFromUrl(redirectUrl: string): Promise<void> {
  const client = buildOAuthClient();
  let u: URL;
  try {
    u = new URL(redirectUrl, `http://localhost:${OAUTH_CALLBACK_PORT}`);
  } catch {
    throw new CliError(`Could not parse redirect URL: ${redirectUrl}`, "INVALID_REDIRECT_URL");
  }
  if (!u.searchParams.get("code")) {
    throw new CliError(
      "That URL has no ?code= parameter — paste the FULL redirect URL Intuit sent you to after authorizing.",
      "INVALID_REDIRECT_URL"
    );
  }
  const realmId = u.searchParams.get("realmId") ?? undefined;
  const resp = await client.createToken(redirectUrl);
  const stored = persistTokenResponse(tokenJsonFrom(resp, client), loadTokens(), realmId);
  await maybeWriteRealmToEnv(realmId);
  outputOk(authSuccessData(stored, "Authenticated (from pasted redirect URL)"));
}

// ------------------------------------------------------------------- status

export async function refreshAndPrint(): Promise<void> {
  const stored = await refreshTokens();
  outputOk(
    authSuccessData(stored, "Token refreshed (rotated refresh token persisted)"),
    () =>
      `Refreshed. Access token good until ${stored.access_token_expires_at}; refresh window ends ${stored.refresh_token_expires_at}.`
  );
}

export function printStatus(): void {
  const t = loadTokens();
  if (!t) {
    throw new CliError(
      "Not authenticated — no tokens.json. Run: quickbooks-cli auth",
      "NOT_AUTHENTICATED"
    );
  }
  const now = Date.now();
  const accessMs = Date.parse(t.access_token_expires_at) - now;
  const refreshMs = Date.parse(t.refresh_token_expires_at) - now;
  const warning =
    refreshMs <= 0
      ? "Refresh token EXPIRED — re-run: quickbooks-cli auth"
      : refreshMs <= 7 * 86_400_000
        ? "Refresh token expires within 7 days — make sure the daily `auth --refresh` cron is running"
        : undefined;
  const data = {
    environment: t.environment,
    realm_id: t.realm_id ?? null,
    access_token: {
      expires_at: t.access_token_expires_at,
      expires_in_seconds: Math.round(accessMs / 1000),
      expired: accessMs <= 0,
    },
    refresh_token: {
      expires_at: t.refresh_token_expires_at,
      expires_in_days: +(refreshMs / 86_400_000).toFixed(1),
      expired: refreshMs <= 0,
      last_rotated_at: t.refreshed_at,
    },
    obtained_at: t.obtained_at,
    tokens_file: TOKENS_FILE,
    ...(warning ? { warning } : {}),
  };
  outputOk(data, () =>
    [
      `Environment:    ${data.environment}`,
      `Realm:          ${data.realm_id ?? "(unset)"}`,
      `Access token:   ${data.access_token.expired ? "EXPIRED" : `expires in ${Math.round(accessMs / 60_000)}m`} (${t.access_token_expires_at})`,
      `Refresh token:  ${data.refresh_token.expired ? "EXPIRED" : `expires in ${data.refresh_token.expires_in_days}d`} (last rotated ${t.refreshed_at})`,
      `First auth:     ${t.obtained_at}`,
      `Tokens file:    ${TOKENS_FILE}`,
      ...(warning ? [`WARNING:        ${warning}`] : []),
    ].join("\n")
  );
}
