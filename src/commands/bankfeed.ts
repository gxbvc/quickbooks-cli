// BEST-EFFORT bank-feed snapshot via UNOFFICIAL internal endpoints.
//
// The official QBO API cannot see bank-feed "For Review" transactions. This
// command shells out to `agent-chrome` and runs same-origin/CORS fetches inside
// an already-logged-in qbo.intuit.com tab (eval in place — it NEVER navigates
// existing tabs). Brittle by nature: unversioned endpoints, rides on browser
// session cookies + Intuit's public web-app API keys.
//
// As of mid-2026 the original single endpoint
//   https://qbo.intuit.com/api/neo/v1/company/{realm}/olb/ng/getInitialData
// returns HTTP 500 for eval-context fetches (the whole `.../api/neo/*` gateway
// rejects fetches that don't originate from the app's own runtime — even with
// byte-identical headers). We still try it first (in case Intuit revives it),
// then fall back to two endpoints that DO answer a cookie-authenticated fetch:
//   - vault.api.intuit.com/v2/search/connections  -> connected bank accounts +
//     live bank balances (nickName, currentBalance, mask, last refresh time)
//   - accounting-txn-svcs.api.intuit.com/.../banking/getTransactions -> the
//     "For Review" queue; the global (no accountId) call returns the total plus
//     every pending item, each tagged with its qboAccountId, so we tally counts
//     per account from the items.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROD_BANKFEED_REALM, getEnvironment } from "../config.js";
import { CliError, fmtMoney, outputOk, renderTable } from "../output.js";

const execFileAsync = promisify(execFile);

// Public QBO web-app API keys (shipped in the browser bundle, not user secrets).
// If Intuit rotates these the fallback fetches will 401/403 and bankfeed will
// report NOT_LOGGED_IN / a fetch error — grab fresh keys from a devtools capture
// of qbo.intuit.com's banking page (Authorization: Intuit_APIKey intuit_apikey=…).
const VAULT_APIKEY = "prdakyres30II8BtPGgnrAQwUSUKAl55ug2Yh3pz";
const TXN_APIKEY = "prdakyresxaDrhFXaSARXaUdj1S8M7h6YK7YGekc";

// getInitialData (legacy) extraction markers.
const NAME_KEYS = ["accountName", "name", "nickName", "nickname", "qboAccountName", "olbAccountName", "displayName"];
const ID_KEYS = ["qboAccountId", "accountId", "olbAccountId", "id"];
const MASK_KEYS = ["maskedAccountNumber", "accountNumberMasked", "mask", "accountNumber"];
const TIME_KEYS = ["lastUpdateTime", "lastUpdatedTime", "lastRefreshTime", "lastRefreshedTime"];
const MARKER_KEYS = ["qboBalance", "bankBalance", "numTxnToReview", "unmatchedCount"];

function firstLine(s: unknown): string {
  return String(s ?? "").trim().split("\n")[0];
}

async function findQboTab(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("agent-chrome", ["tabs"], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new CliError(
        "agent-chrome not found on PATH — bankfeed needs it (see ~/notes/web-browsing.md).",
        "AGENT_CHROME_MISSING"
      );
    }
    throw new CliError(
      `\`agent-chrome tabs\` failed: ${firstLine(err?.stderr || err?.message)}. Is Chrome running with --remote-debugging-port=9222?`,
      "AGENT_CHROME_ERROR"
    );
  }
  for (const line of stdout.split("\n")) {
    if (!/qbo\.intuit\.com/.test(line)) continue;
    const id = line.trim().split(/\s+/)[0];
    if (/^t\d+$/.test(id)) return id;
  }
  throw new CliError(
    "No logged-in qbo.intuit.com tab found in Chrome. Open https://qbo.intuit.com, sign in, and re-run. (bankfeed evals in that tab in place; it never navigates your tabs.)",
    "NO_QBO_TAB"
  );
}

interface SubResult {
  label: string;
  status: number;
  body?: string;
  error?: string;
}
interface EvalResult {
  __qbBankfeed: true;
  initialData?: SubResult;
  vault?: SubResult;
  txn?: SubResult;
  fatalError?: string;
}

function parseEvalOutput(stdout: string): EvalResult {
  // agent-chrome may print the result raw or JSON-quoted; try whole output,
  // then per-line, unwrapping up to three layers of JSON string encoding.
  const candidates = [stdout.trim(), ...stdout.split("\n").map((l) => l.trim()).filter(Boolean)];
  for (const c of candidates) {
    let v: unknown = c;
    for (let i = 0; i < 3 && typeof v === "string"; i++) {
      try {
        v = JSON.parse(v);
      } catch {
        break;
      }
    }
    if (v && typeof v === "object" && "__qbBankfeed" in (v as object)) return v as EvalResult;
  }
  throw new CliError(
    "Unexpected agent-chrome eval output (could not find the fetch result).",
    "BANKFEED_PARSE",
    stdout.slice(0, 400)
  );
}

/** Build the in-page JS that fetches all three sources in one round-trip. */
function buildEvalJs(realm: string): string {
  // agent-chrome eval gotchas: expression context (no `return`), use `var`,
  // multi-line JS goes through --file. The last expression (a promise) is awaited.
  return [
    `var __realm = ${JSON.stringify(realm)};`,
    `var __csrf = (document.cookie.match(/(?:^|;\\s*)qbo\\.csrftoken=([^;]+)/) || [])[1] || "";`,
    `var __uid = (document.cookie.match(/(?:^|;\\s*)userIdentifier=([^;]+)/) || [])[1] || "";`,
    `var __neoUrl = "https://qbo.intuit.com/api/neo/v1/company/" + __realm + "/olb/ng/getInitialData";`,
    `var __vaultUrl = "https://vault.api.intuit.com/v2/search/connections?Intuit-Company-ID=" + __realm + "&country_code=US&flow_name=ManageConnectionStatus&intuit_apikey=${VAULT_APIKEY}&intuit_offeringid=Intuit.platform.qbo.dtx.ui&isRealmContext=true&locale=en_us";`,
    `var __vaultBody = JSON.stringify({ acquireAccounts: true, acquireMigrations: true, knownIssues: false, visibleAccounts: false, filterNoAccountConnections: false });`,
    `var __txnUrl = "https://accounting-txn-svcs.api.intuit.com/v1/company/" + __realm + "/banking/getTransactions?sort=-txnDate&reviewState=PENDING&ignoreMatching=false";`,
    `var __txnHd = { Accept: "application/json", Authorization: "Intuit_APIKey intuit_apikey=${TXN_APIKEY}, intuit_apikey_version=1.0", Csrftoken: __csrf, authType: "browser_auth", apiKey: "${TXN_APIKEY}", "intuit-company-id": __realm, "intuit-user-id": __uid, "X-Range": "items=0-999" };`,
    `var __grab = function (label, p) { return p.then(function (r) { return r.text().then(function (b) { return { label: label, status: r.status, body: b }; }); }).catch(function (e) { return { label: label, status: 0, error: String(e) }; }); };`,
    `Promise.all([`,
    `  __grab("initialData", fetch(__neoUrl, { credentials: "include", headers: { Accept: "application/json" } })),`,
    `  __grab("vault", fetch(__vaultUrl, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: __vaultBody })),`,
    `  __grab("txn", fetch(__txnUrl, { credentials: "include", headers: __txnHd }))`,
    `]).then(function (rs) { var out = { __qbBankfeed: true }; rs.forEach(function (x) { out[x.label] = x; }); return JSON.stringify(out); })`,
    `  .catch(function (e) { return JSON.stringify({ __qbBankfeed: true, fatalError: String(e) }); })`,
  ].join("\n");
}

async function evalInTab(tabId: string, realm: string): Promise<EvalResult> {
  const dir = mkdtempSync(join(tmpdir(), "quickbooks-cli-"));
  const file = join(dir, "bankfeed.js");
  writeFileSync(file, buildEvalJs(realm));
  try {
    const { stdout } = await execFileAsync(
      "agent-chrome",
      ["--tab", tabId, "--timeout", "60", "eval", "--file", file],
      { timeout: 90_000, maxBuffer: 50 * 1024 * 1024 }
    );
    return parseEvalOutput(stdout);
  } catch (err: any) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `agent-chrome eval failed: ${firstLine(err?.stderr || err?.message)}`,
      "AGENT_CHROME_ERROR"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- getInitialData

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function collectAccountObjects(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectAccountObjects(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (MARKER_KEYS.some((k) => k in obj)) {
    out.push(obj);
    return;
  }
  for (const v of Object.values(obj)) collectAccountObjects(v, out);
}

function extractInitialDataAccounts(payload: unknown) {
  const found: Record<string, unknown>[] = [];
  collectAccountObjects(payload, found);
  return found.map((o) => ({
    name: pick(o, NAME_KEYS) ?? null,
    accountId: pick(o, ID_KEYS) ?? null,
    mask: pick(o, MASK_KEYS) ?? null,
    qboBalance: o.qboBalance ?? null,
    bankBalance: o.bankBalance ?? null,
    numTxnToReview: o.numTxnToReview ?? null,
    unmatchedCount: o.unmatchedCount ?? null,
    lastUpdateTime: pick(o, TIME_KEYS) ?? null,
  }));
}

// ------------------------------------------------------------------- helpers

function safeJson(body: string | undefined): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function looksLikeHtml(body: string | undefined): boolean {
  return /^\s*</.test(body ?? "");
}

/** vault connections -> per-account bank balances + metadata. */
function extractVaultAccounts(payload: unknown) {
  const conns = Array.isArray(payload) ? payload : [];
  const accounts: Array<Record<string, unknown>> = [];
  for (const conn of conns) {
    const c = conn as Record<string, unknown>;
    const list = Array.isArray(c.accounts) ? c.accounts : [];
    for (const a of list) {
      const acct = a as Record<string, unknown>;
      accounts.push({
        provider: c.name ?? null,
        name: acct.nickName ?? null,
        mask: acct.accountNumberMasked ?? null,
        type: acct.accountType ?? null,
        bankBalance: acct.currentBalance ?? null,
        lastUpdateTime: acct.lastSuccessfulRefreshTime ?? null,
        fdpAccountId: acct.accountId ?? null,
      });
    }
  }
  return accounts;
}

/** txn-svcs getTransactions (global) -> For Review total + per-qboAccountId tally. */
function extractForReview(payload: unknown) {
  const p = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
  const byAccountId: Record<string, number> = {};
  for (const it of items) {
    const id = it.qboAccountId != null ? String(it.qboAccountId) : "unknown";
    byAccountId[id] = (byAccountId[id] ?? 0) + 1;
  }
  const total =
    typeof p.totalTransactionsCount === "number" ? p.totalTransactionsCount : items.length;
  // items may be paginated; flag if we clearly saw fewer than the reported total.
  const partial = items.length > 0 && total > items.length;
  return {
    total,
    byAccountId,
    tallied: items.length,
    partial,
    confidenceCounts: (p.confidenceCounts as Record<string, unknown>) ?? null,
  };
}

// --------------------------------------------------------------------- command

export async function bankfeed(opts: { realm?: string; raw?: boolean }): Promise<void> {
  let realm = opts.realm;
  if (!realm) {
    if (getEnvironment() === "production") {
      realm = DEFAULT_PROD_BANKFEED_REALM;
    } else {
      throw new CliError(
        "bankfeed reads the LIVE qbo.intuit.com browser session (there is no sandbox for it). Pass --realm <id> explicitly, or set QB_ENVIRONMENT=production to default to the Abelian realm.",
        "REALM_REQUIRED"
      );
    }
  }

  const tabId = await findQboTab();
  const result = await evalInTab(tabId, realm);
  if (result.fatalError) {
    throw new CliError(`In-page fetch failed: ${result.fatalError}.`, "BANKFEED_FETCH_FAILED");
  }

  const initial = result.initialData;
  const vault = result.vault;
  const txn = result.txn;

  // 1) Prefer getInitialData if it ever comes back (forward-compat).
  if (initial && initial.status === 200 && !looksLikeHtml(initial.body)) {
    const payload = safeJson(initial.body);
    if (payload !== undefined) {
      const accounts = extractInitialDataAccounts(payload);
      if (accounts.length > 0) {
        emit(realm, "olb getInitialData", accounts, null, opts.raw ? { initialData: payload } : undefined);
        return;
      }
    }
  }

  // 2) Fallback: vault (balances) + txn-svcs (For Review). Detect auth failures.
  const vaultPayload = safeJson(vault?.body);
  const vaultOk = vault?.status === 200 && Array.isArray(vaultPayload);
  const authFailed = (s?: SubResult) => !!s && (s.status === 401 || s.status === 403 || looksLikeHtml(s.body));

  if (!vaultOk) {
    // Distinguish "logged out / wrong company" from a server/endpoint failure.
    if (authFailed(vault) || authFailed(txn)) {
      throw new CliError(
        `The qbo.intuit.com tab (${tabId}) is not authenticated for realm ${realm} (vault HTTP ${vault?.status ?? "?"}, txn HTTP ${txn?.status ?? "?"}). Sign in to the right QuickBooks company and re-run.`,
        "NOT_LOGGED_IN"
      );
    }
    throw new CliError(
      `Bank-feed fallback endpoints did not return account data (getInitialData HTTP ${initial?.status ?? "?"}, vault HTTP ${vault?.status ?? "?"}, txn HTTP ${txn?.status ?? "?"}). The unofficial endpoints may have changed or the public API keys rotated. Re-run with --raw to inspect.`,
      "BANKFEED_ENDPOINT_ERROR",
      opts.raw
        ? { initialData: initial, vault, txn }
        : firstLine(vault?.body || txn?.body || initial?.body)
    );
  }

  const accounts = extractVaultAccounts(vaultPayload);
  const txnPayload = safeJson(txn?.body);
  const forReview = txn?.status === 200 && txnPayload !== undefined ? extractForReview(txnPayload) : null;

  const raw = opts.raw
    ? { initialData: initial, vault: vaultPayload, txn: txnPayload }
    : undefined;
  emit(realm, "vault connections + accounting-txn-svcs (getInitialData retired)", accounts, forReview, raw);
}

type ForReview = ReturnType<typeof extractForReview>;

function emit(
  realm: string,
  source: string,
  accounts: Array<Record<string, unknown>>,
  forReview: ForReview | null,
  raw: unknown
): void {
  const data: Record<string, unknown> = {
    realmId: realm,
    fetchedAt: new Date().toISOString(),
    source: `unofficial ${source} (best-effort)`,
    count: accounts.length,
    accounts,
  };
  if (forReview) {
    data.forReview = {
      total: forReview.total,
      byAccountId: forReview.byAccountId,
      ...(forReview.partial ? { partial: true, tallied: forReview.tallied } : {}),
      ...(forReview.confidenceCounts ? { confidenceCounts: forReview.confidenceCounts } : {}),
    };
  }
  if (accounts.length === 0) {
    data.note =
      "No account-shaped objects found — the internal endpoint's shape may have changed. Re-run with --raw to inspect the full payload.";
  }
  if (raw !== undefined) data.raw = raw;

  outputOk(data, () => {
    const table = renderTable(
      ["Account", "Type", "Bank balance", "For review", "Last update"],
      accounts.map((a) => [
        [a.name, a.mask].filter(Boolean).join(" "),
        (a.type as string | null) ?? "",
        fmtMoney(a.bankBalance),
        // getInitialData carries per-account numTxnToReview directly; the vault
        // path can't be joined to txn-svcs qboAccountIds, so leave blank there.
        (a.numTxnToReview as number | null) ?? "",
        (a.lastUpdateTime as string | null) ?? "",
      ])
    );
    if (!forReview) return table;
    const by = Object.entries(forReview.byAccountId)
      .map(([id, n]) => `${id}:${n}`)
      .join("  ");
    return (
      table +
      `\n\nFor Review total: ${forReview.total}` +
      (by ? `\nBy QBO account id: ${by}` : "") +
      (forReview.partial ? `\n(partial: tallied ${forReview.tallied} of ${forReview.total})` : "")
    );
  });
}
