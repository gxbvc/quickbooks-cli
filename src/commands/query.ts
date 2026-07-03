import { queryAll } from "../http.js";
import { outputOk } from "../output.js";

export async function runQuery(sql: string, opts: { max?: number }): Promise<void> {
  const result = await queryAll(sql, opts.max);
  outputOk({
    query: sql,
    entityType: result.entityType,
    count: result.entities.length,
    ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
    ...(result.capped ? { capped: true } : {}),
    entities: result.entities,
  });
}
