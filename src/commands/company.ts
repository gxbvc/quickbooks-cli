import { getRealmId } from "../config.js";
import { qbGet } from "../http.js";
import { outputOk } from "../output.js";

export async function companyInfo(): Promise<void> {
  const realm = getRealmId();
  const body = await qbGet(`companyinfo/${encodeURIComponent(realm)}`);
  const info = body?.CompanyInfo ?? body;
  outputOk(info, () => {
    const rows: Array<[string, unknown]> = [
      ["Company", info?.CompanyName],
      ["Legal name", info?.LegalName],
      ["Realm", realm],
      ["Country", info?.Country],
      ["Started", info?.CompanyStartDate],
      ["Fiscal year start", info?.FiscalYearStartMonth],
      ["Email", info?.Email?.Address],
      ["File created", info?.MetaData?.CreateTime],
    ];
    return rows
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k.padEnd(18)} ${v}`)
      .join("\n");
  });
}
