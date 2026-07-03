import { qbGet } from "../http.js";
import { CliError, outputOk } from "../output.js";

export async function getEntity(type: string, id: string): Promise<void> {
  if (!/^[A-Za-z]+$/.test(type)) {
    throw new CliError(
      `Invalid entity type "${type}" — use a QBO entity name like Invoice, Purchase, or JournalEntry.`,
      "INVALID_ENTITY_TYPE"
    );
  }
  const body = await qbGet(`${type.toLowerCase()}/${encodeURIComponent(id)}`);
  const key = Object.keys(body ?? {}).find((k) => k.toLowerCase() === type.toLowerCase());
  outputOk(key ? body[key] : body);
}
