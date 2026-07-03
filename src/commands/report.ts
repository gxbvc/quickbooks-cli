import { qbGet } from "../http.js";
import { CliError, outputOk } from "../output.js";

/** kebab-case CLI names -> Intuit Reports API names */
export const REPORT_MAP: Record<string, string> = {
  "profit-and-loss": "ProfitAndLoss",
  "profit-and-loss-detail": "ProfitAndLossDetail",
  "balance-sheet": "BalanceSheet",
  "general-ledger": "GeneralLedger",
  "trial-balance": "TrialBalance",
  "cash-flow": "CashFlow",
  "transaction-list": "TransactionList",
  "transaction-list-with-splits": "TransactionListWithSplits",
  "aged-receivables": "AgedReceivables",
  "aged-receivable-detail": "AgedReceivableDetail",
  "aged-payables": "AgedPayables",
  "aged-payable-detail": "AgedPayableDetail",
  "account-list": "AccountList",
  "vendor-expenses": "VendorExpenses",
  "customer-income": "CustomerIncome",
};

export interface ReportOpts {
  start?: string;
  end?: string;
  dateMacro?: string;
  accountingMethod?: string;
  detail?: boolean;
  param?: string[];
  testingMigration?: boolean;
}

export async function runReport(name: string, opts: ReportOpts): Promise<void> {
  let key = name.toLowerCase();
  if (opts.detail && !key.endsWith("-detail")) key = `${key}-detail`;
  let reportName = REPORT_MAP[key];
  if (!reportName) {
    reportName = key
      .split("-")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join("");
    process.stderr.write(
      `Unknown report "${key}" — passing through to the API as "${reportName}". Known reports: ${Object.keys(REPORT_MAP).join(", ")}\n`
    );
  }

  const params: Record<string, string | undefined> = {
    start_date: opts.start,
    end_date: opts.end,
    date_macro: opts.dateMacro,
    accounting_method: opts.accountingMethod,
    // Opt into the Aug 31, 2026 Reports-modernization response format early.
    ...(opts.testingMigration ? { testing_migration: "true" } : {}),
  };
  for (const p of opts.param ?? []) {
    const i = p.indexOf("=");
    if (i < 1) throw new CliError(`--param expects key=value, got "${p}"`, "INVALID_PARAM");
    params[p.slice(0, i)] = p.slice(i + 1);
  }

  const body = await qbGet(`reports/${reportName}`, params);
  outputOk(body, () => renderReport(body));
}

// -------------------------------------------------------------- pretty print

function colDataLine(colData: any[], indent: string): string {
  return indent + colData.map((c) => c?.value ?? "").join(" | ");
}

function walkRows(rows: any[], depth: number, lines: string[]): void {
  for (const row of rows ?? []) {
    const indent = "  ".repeat(depth);
    if (Array.isArray(row?.ColData)) lines.push(colDataLine(row.ColData, indent));
    if (Array.isArray(row?.Header?.ColData)) lines.push(colDataLine(row.Header.ColData, indent));
    if (Array.isArray(row?.Rows?.Row)) walkRows(row.Rows.Row, depth + 1, lines);
    if (Array.isArray(row?.Summary?.ColData)) lines.push(colDataLine(row.Summary.ColData, indent));
  }
}

function renderReport(report: any): string {
  const lines: string[] = [];
  const h = report?.Header ?? {};
  const period = [h.StartPeriod, h.EndPeriod].filter(Boolean).join(" to ");
  lines.push(
    [h.ReportName ?? "Report", period, h.ReportBasis ? `(${h.ReportBasis})` : ""]
      .filter(Boolean)
      .join("  ")
  );
  const cols = (report?.Columns?.Column ?? []).map((c: any) => c?.ColTitle ?? "");
  if (cols.some(Boolean)) lines.push(cols.join(" | "));
  lines.push("");
  walkRows(report?.Rows?.Row ?? [], 0, lines);
  return lines.join("\n");
}
