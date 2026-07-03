import { qbGet } from "../http.js";
import { CliError, outputOk, renderTable } from "../output.js";

const DEFAULT_ENTITIES = [
  "Purchase",
  "Deposit",
  "Transfer",
  "JournalEntry",
  "Bill",
  "BillPayment",
  "Invoice",
  "Payment",
  "VendorCredit",
];

const CDC_WINDOW_MS = 30 * 86_400_000;

function parseSince(raw: string): Date {
  const rel = /^(\d+)d$/i.exec(raw.trim());
  let d: Date;
  if (rel) {
    d = new Date(Date.now() - Number(rel[1]) * 86_400_000);
  } else {
    const t = Date.parse(raw);
    if (Number.isNaN(t)) {
      throw new CliError(
        `Could not parse --since "${raw}". Use YYYY-MM-DD, an ISO datetime, or Nd (e.g. 30d).`,
        "INVALID_SINCE"
      );
    }
    d = new Date(t);
  }
  const age = Date.now() - d.getTime();
  if (age < 0) throw new CliError("--since is in the future.", "INVALID_SINCE");
  if (age > CDC_WINDOW_MS + 60_000) {
    throw new CliError(
      `--since resolves to ${d.toISOString()}, more than 30 days ago. QuickBooks' CDC (change data capture) endpoint only returns changes from the last 30 days. For older history, use \`quickbooks-cli query\` with a WHERE clause, e.g. quickbooks-cli query "SELECT * FROM Purchase WHERE TxnDate >= '2026-01-01'".`,
      "CDC_WINDOW_EXCEEDED"
    );
  }
  return d;
}

export async function changedTransactions(opts: {
  since: string;
  entities?: string;
}): Promise<void> {
  const since = parseSince(opts.since);
  const entities = opts.entities
    ? opts.entities.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ENTITIES;
  const body = await qbGet("cdc", {
    entities: entities.join(","),
    changedSince: since.toISOString(),
  });
  const responses: any[] = body?.CDCResponse?.[0]?.QueryResponse ?? [];
  const byType: Record<string, any[]> = {};
  for (const qr of responses) {
    for (const [k, v] of Object.entries(qr ?? {})) {
      if (Array.isArray(v)) byType[k] = (byType[k] ?? []).concat(v);
    }
  }
  const counts = Object.fromEntries(entities.map((e) => [e, byType[e]?.length ?? 0]));
  outputOk(
    { changedSince: since.toISOString(), counts, entities: byType },
    () =>
      `Changes since ${since.toISOString()} (deleted rows carry status: "Deleted"):\n` +
      renderTable(
        ["Entity", "Changed"],
        Object.entries(counts).map(([k, v]) => [k, v as number])
      )
  );
}
