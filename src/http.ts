// Thin hand-rolled fetch client for the QuickBooks Online v3 API.
//
// READ-ONLY GUARANTEE: this is the only module that talks to the API, and it
// refuses everything except GET and POST to the /query and /text endpoints
// (the query language can be POSTed as text). There are no create/update/
// delete code paths anywhere in this tool.
import { MINOR_VERSION, getApiBase, getRealmId } from "./config.js";
import { getValidAccessToken, refreshTokens } from "./auth.js";
import { CliError } from "./output.js";

const MAX_RETRIES = 3; // exponential backoff with jitter on 429
const POST_ALLOWED_SEGMENTS = new Set(["query", "text"]);

function assertReadOnly(method: string, relPath: string): void {
  if (method === "GET") return;
  const last =
    relPath
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .pop() ?? "";
  if (method === "POST" && POST_ALLOWED_SEGMENTS.has(last.toLowerCase())) return;
  throw new CliError(
    `Read-only guarantee: refusing ${method} ${relPath}. Only GET, and POST to /query or /text, are permitted.`,
    "READ_ONLY_VIOLATION"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFault(body: unknown): { message: string; code: string } | null {
  const b = body as Record<string, any> | null;
  const fault = b?.Fault ?? b?.fault;
  const errs = fault?.Error ?? fault?.error;
  const e = Array.isArray(errs) ? errs[0] : undefined;
  if (!e) return null;
  const message = [e.Message ?? e.message, e.Detail ?? e.detail].filter(Boolean).join(" — ");
  return {
    message: message || "QuickBooks API fault",
    code: `QB_${e.code ?? fault?.type ?? "FAULT"}`,
  };
}

interface RequestOpts {
  params?: Record<string, string | number | undefined>;
  body?: string;
  contentType?: string;
}

async function qbRequest(method: "GET" | "POST", relPath: string, opts: RequestOpts = {}): Promise<any> {
  assertReadOnly(method, relPath);
  const realm = getRealmId();
  const url = new URL(`${getApiBase()}/v3/company/${encodeURIComponent(realm)}/${relPath}`);
  url.searchParams.set("minorversion", MINOR_VERSION);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let refreshed = false;
  let retries = 0;
  for (;;) {
    const token = await getValidAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body !== undefined
          ? { "Content-Type": opts.contentType ?? "application/text" }
          : {}),
      },
      body: opts.body,
    });

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshTokens(); // rotate + persist, then retry once
      continue;
    }
    if (res.status === 429 && retries < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** retries) + Math.random() * 300;
      process.stderr.write(`Rate limited (429); retrying in ${Math.round(delay)}ms...\n`);
      await sleep(delay);
      retries++;
      continue;
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const fault = extractFault(body);
      throw new CliError(
        fault?.message ?? `QuickBooks API error ${res.status} on ${method} ${relPath}`,
        fault?.code ?? `HTTP_${res.status}`,
        typeof body === "string" ? body.slice(0, 500) : (body ?? undefined)
      );
    }
    return body;
  }
}

/** GET {base}/v3/company/{realm}/{relPath}?minorversion=75&... */
export function qbGet(relPath: string, params?: RequestOpts["params"]): Promise<any> {
  return qbRequest("GET", relPath, { params });
}

/** POST the SQL-ish query language to /query as text (read-only by definition). */
export function qbQuery(sql: string): Promise<any> {
  return qbRequest("POST", "query", { body: sql, contentType: "application/text" });
}

// ---------------------------------------------------------------- pagination

export interface QueryResult {
  entityType: string | null;
  entities: any[];
  totalCount?: number;
  /** true when --max capped the fetch and more rows may exist */
  capped?: boolean;
}

function extractPage(body: any): { key: string | null; rows: any[]; totalCount?: number } {
  const qr = body?.QueryResponse ?? {};
  for (const [k, v] of Object.entries(qr)) {
    if (Array.isArray(v)) return { key: k, rows: v, totalCount: qr.totalCount };
  }
  return { key: null, rows: [], totalCount: qr.totalCount };
}

/**
 * Run a query with automatic STARTPOSITION/MAXRESULTS pagination (1000/page,
 * the API max). If the query already contains STARTPOSITION or MAXRESULTS it
 * is passed through as a single page. COUNT queries return totalCount only.
 */
export async function queryAll(sql: string, max?: number): Promise<QueryResult> {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (/\bSTARTPOSITION\b|\bMAXRESULTS\b/i.test(trimmed)) {
    const page = extractPage(await qbQuery(trimmed));
    return { entityType: page.key, entities: page.rows, totalCount: page.totalCount };
  }
  if (/^select\s+count\s*\(\s*\*\s*\)/i.test(trimmed)) {
    const body = await qbQuery(trimmed);
    return { entityType: null, entities: [], totalCount: body?.QueryResponse?.totalCount };
  }

  const pageSize = 1000;
  const entities: any[] = [];
  let entityType: string | null = null;
  let start = 1;
  let capped = false;
  for (;;) {
    const size = max !== undefined ? Math.min(pageSize, max - entities.length) : pageSize;
    if (size <= 0) {
      capped = true;
      break;
    }
    const page = extractPage(await qbQuery(`${trimmed} STARTPOSITION ${start} MAXRESULTS ${size}`));
    if (page.key) entityType = page.key;
    entities.push(...page.rows);
    if (page.rows.length < size) break;
    start += page.rows.length;
  }
  return { entityType, entities, ...(capped ? { capped: true } : {}) };
}
