// Output helpers: {"ok":true,"data":...} JSON envelope by default, --pretty for humans.

let _pretty = false;

export function setPretty(val: boolean): void {
  _pretty = val;
}

export function isPretty(): boolean {
  return _pretty;
}

/** Typed error carrying a machine-readable code for the JSON envelope. */
export class CliError extends Error {
  constructor(
    message: string,
    public code: string = "ERROR",
    public details?: unknown
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Success output. JSON envelope on stdout by default; in --pretty mode prints
 * `prettyText` (string or lazy fn) or falls back to indented JSON.
 */
export function outputOk(data: unknown, prettyText?: string | (() => string)): void {
  if (_pretty) {
    const text = typeof prettyText === "function" ? prettyText() : prettyText;
    console.log(text ?? JSON.stringify(data, null, 2));
    return;
  }
  console.log(JSON.stringify({ ok: true, data }));
}

/** Error output: envelope to stdout, human message to stderr, exit 1. */
export function outputError(error: string, code = "ERROR", details?: unknown): never {
  console.log(
    JSON.stringify({ ok: false, error, code, ...(details !== undefined ? { details } : {}) })
  );
  console.error(`Error [${code}]: ${error}`);
  process.exit(1);
}

/** Wrap a command action: catches thrown errors and emits the error envelope. */
export async function run(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CliError) outputError(err.message, err.code, err.details);
    outputError(err instanceof Error ? err.message : String(err), "ERROR");
  }
}

/** Plain-text table for --pretty output. */
export function renderTable(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>
): string {
  const cells = rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length), 1)
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...cells.map(line),
  ].join("\n");
}

export function fmtMoney(v: unknown): string {
  if (typeof v === "number") return v.toFixed(2);
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v).toFixed(2);
  return v == null ? "" : String(v);
}
