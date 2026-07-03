import { queryAll } from "../http.js";
import { fmtMoney, outputOk, renderTable } from "../output.js";

export async function listAccounts(opts: { all?: boolean; max?: number }): Promise<void> {
  // QBO queries return active accounts only unless Active is filtered explicitly.
  const sql = opts.all
    ? "SELECT * FROM Account WHERE Active IN (true, false)"
    : "SELECT * FROM Account";
  const { entities, capped } = await queryAll(sql, opts.max);
  const accounts = [...entities].sort(
    (a, b) =>
      String(a.AcctNum ?? "").localeCompare(String(b.AcctNum ?? "")) ||
      String(a.Name ?? "").localeCompare(String(b.Name ?? ""))
  );
  outputOk({ count: accounts.length, ...(capped ? { capped: true } : {}), accounts }, () =>
    renderTable(
      ["Num", "Name", "Type", "Subtype", "Balance", "Currency", "Active"],
      accounts.map((a) => [
        a.AcctNum,
        a.Name,
        a.AccountType,
        a.AccountSubType,
        fmtMoney(a.CurrentBalance),
        a.CurrencyRef?.value,
        a.Active === false ? "no" : "yes",
      ])
    )
  );
}
