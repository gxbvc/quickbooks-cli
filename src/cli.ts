import { Command } from "commander";
import { outputError, run, setPretty } from "./output.js";

const program = new Command();

program
  .name("quickbooks-cli")
  .description(
    "READ-ONLY access to QuickBooks Online. The HTTP layer only permits GET and POST to /query|/text — no create/update/delete code paths exist."
  )
  .version("0.1.0")
  .option("--pretty", "Human-readable output (default: single-line JSON envelope)")
  .hook("preAction", (_thisCommand, actionCommand) => {
    if ((actionCommand.optsWithGlobals() as { pretty?: boolean }).pretty) setPretty(true);
  });

/** Add shared flags so `--pretty` works after the subcommand too. */
function withPretty(cmd: Command): Command {
  return cmd.option("--pretty", "Human-readable output");
}

// ---------------------------------------------------------------------- auth

withPretty(
  program
    .command("auth")
    .description(
      "OAuth2 handshake with Intuit (opens a browser; callback on localhost:3456). Tokens persist to gitignored tokens.json (0600) and auto-refresh before every command."
    )
)
  .option("--refresh", "Refresh the access token now and persist the rotated refresh token (cron this daily)")
  .option("--status", "Show token ages and expiries (no network call)")
  .option(
    "--from-url <url>",
    "Complete auth from a pasted redirect URL (production flow with a hosted HTTPS callback; set QB_REDIRECT_URI to match)"
  )
  .action(async (opts) => {
    const auth = await import("./auth.js");
    await run(async () => {
      if (opts.status) return auth.printStatus();
      if (opts.refresh) return void (await auth.refreshAndPrint());
      if (opts.fromUrl) return void (await auth.completeFromUrl(opts.fromUrl));
      return void (await auth.runAuthFlow());
    });
  });

// ------------------------------------------------------------------- company

withPretty(
  program.command("company").description("Fetch CompanyInfo for the configured realm")
).action(async () => {
  const { companyInfo } = await import("./commands/company.js");
  await run(() => companyInfo());
});

// ------------------------------------------------------------------ accounts

withPretty(
  program.command("accounts").description("Chart of accounts with balances (queries Account)")
)
  .option("--all", "Include inactive accounts")
  .option("--max <n>", "Cap the number of accounts fetched", (v: string) => parseInt(v, 10))
  .action(async (opts) => {
    const { listAccounts } = await import("./commands/accounts.js");
    await run(() => listAccounts(opts));
  });

// --------------------------------------------------------------------- query

withPretty(
  program
    .command("query <sql>")
    .description(
      'Raw QBO query passthrough with automatic STARTPOSITION/MAXRESULTS pagination, e.g. "SELECT * FROM Purchase WHERE TxnDate > \'2026-06-01\'"'
    )
)
  .option("--max <n>", "Cap total rows fetched (default: fetch all pages)", (v: string) =>
    parseInt(v, 10)
  )
  .action(async (sql: string, opts) => {
    const { runQuery } = await import("./commands/query.js");
    await run(() => runQuery(sql, opts));
  });

// -------------------------------------------------------------------- entity

withPretty(
  program
    .command("entity <type> <id>")
    .description("Fetch any entity by id, e.g. `entity Invoice 123` or `entity JournalEntry 45`")
).action(async (type: string, id: string) => {
  const { getEntity } = await import("./commands/entity.js");
  await run(() => getEntity(type, id));
});

// ---------------------------------------------------------------------- txns

withPretty(
  program
    .command("txns")
    .description(
      "Changed transactions via the CDC endpoint across Purchase, Deposit, Transfer, JournalEntry, Bill, BillPayment, Invoice, Payment, VendorCredit (30-day window max)"
    )
)
  .requiredOption("--since <when>", "YYYY-MM-DD, ISO datetime, or Nd (e.g. 30d) — at most 30 days back")
  .option("--entities <csv>", "Override the entity list (comma-separated QBO entity names)")
  .action(async (opts) => {
    const { changedTransactions } = await import("./commands/txns.js");
    await run(() => changedTransactions(opts));
  });

// -------------------------------------------------------------------- report

withPretty(
  program
    .command("report <name>")
    .description(
      "Run a Reports API report. Names (kebab-case): profit-and-loss, profit-and-loss-detail, balance-sheet, general-ledger, trial-balance, cash-flow, transaction-list, aged-receivables, aged-payables, account-list, and more."
    )
)
  .option("--start <date>", "start_date (YYYY-MM-DD)")
  .option("--end <date>", "end_date (YYYY-MM-DD)")
  .option("--date-macro <macro>", 'date_macro, e.g. "Last Fiscal Quarter"')
  .option("--accounting-method <method>", "Cash or Accrual")
  .option("--detail", "Use the detail variant of the report (e.g. ProfitAndLossDetail)")
  .option(
    "--param <key=value>",
    "Extra query param, repeatable (e.g. --param summarize_column_by=Month)",
    (v: string, acc: string[]) => acc.concat(v),
    []
  )
  .option(
    "--testing-migration",
    "Add testing_migration=true to preview the Aug 31, 2026 Reports-modernization response format"
  )
  .action(async (name: string, opts) => {
    const { runReport } = await import("./commands/report.js");
    await run(() => runReport(name, opts));
  });

// ------------------------------------------------------------------ bankfeed

withPretty(
  program
    .command("bankfeed")
    .description(
      "BEST-EFFORT, UNOFFICIAL: bank-feed balances and For-Review counts via the internal qbo.intuit.com olb endpoint, evaluated inside an already-logged-in Chrome tab (agent-chrome; never navigates your tabs). The official API cannot see these."
    )
)
  .option("--realm <id>", "Realm to query (defaults to the Abelian realm when QB_ENVIRONMENT=production)")
  .option("--raw", "Include the full raw getInitialData payload in the output")
  .action(async (opts) => {
    const { bankfeed } = await import("./commands/bankfeed.js");
    await run(() => bankfeed(opts));
  });

program.parseAsync().catch((err: Error) => {
  outputError(err.message, "ERROR");
});
