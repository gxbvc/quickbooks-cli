# quickbooks-cli

Read-only access to QuickBooks Online (official v3 API, OAuth2). Cannot write: the HTTP layer only allows GET plus POST to `/query`/`/text`. Output: `{"ok":true,"data":...}` / `{"ok":false,"error":"...","code":"..."}` on stdout, exit 0/1; add `--pretty` for tables.

## Commands

```bash
quickbooks-cli auth                            # One-time browser OAuth (callback localhost:3456; captures realm)
quickbooks-cli auth --refresh                  # Rotate + persist tokens (cron daily; refresh token rotates ~24h)
quickbooks-cli auth --status                   # Token ages/expiries (no network)
quickbooks-cli auth --from-url <url>           # Finish auth from a pasted redirect URL (production)
quickbooks-cli company                         # CompanyInfo
quickbooks-cli accounts [--all] [--max N]      # Chart of accounts w/ balances (--all incl. inactive)
quickbooks-cli query "<SQL-ish>" [--max N]     # Raw /query passthrough, auto-paginated (1000/page)
quickbooks-cli entity <Type> <id>              # Any entity by id (Invoice, Purchase, JournalEntry, ...)
quickbooks-cli txns --since <date|Nd>          # CDC changes, max 30 days back [--entities csv]
quickbooks-cli report <name> [flags]           # Reports API (kebab-case names)
quickbooks-cli bankfeed [--realm ID] [--raw]   # UNOFFICIAL: bank-feed balances + For-Review counts via logged-in Chrome tab (agent-chrome)
```

Report names: `profit-and-loss[-detail]`, `balance-sheet`, `general-ledger`, `trial-balance`, `cash-flow`, `transaction-list[-with-splits]`, `aged-receivables`, `aged-payables`, `aged-receivable-detail`, `aged-payable-detail`, `account-list`, `vendor-expenses`, `customer-income`.
Report flags: `--start YYYY-MM-DD --end YYYY-MM-DD --date-macro "Last Fiscal Quarter" --accounting-method Cash|Accrual --detail --param k=v --testing-migration` (post-Aug-2026 response format).

## Examples

```bash
quickbooks-cli query "SELECT * FROM Purchase WHERE TxnDate > '2026-06-01'"
quickbooks-cli query "SELECT COUNT(*) FROM Invoice"
quickbooks-cli report profit-and-loss --start 2026-04-01 --end 2026-06-30 --pretty
quickbooks-cli txns --since 30d
quickbooks-cli accounts --pretty
quickbooks-cli bankfeed --realm 9341456741690479 --pretty
```

## Notes

- Requires `.env` with `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_ENVIRONMENT` (`sandbox`|`production`), `QB_REALM_ID`. See `.env.example`. Optional `QB_REDIRECT_URI` for production auth.
- Tokens live in gitignored `tokens.json` (0600); access tokens auto-refresh before every command. Keep a daily cron on `auth --refresh` so the rotating refresh token (100-day window) never lapses.
- `txns` (CDC) hard-fails past 30 days — use `query` with a `WHERE TxnDate >= '...'` for older data.
- `bankfeed` is best-effort against an unofficial qbo.intuit.com endpoint: needs Chrome on `--remote-debugging-port=9222` with a logged-in qbo.intuit.com tab; it evals in place, never navigates tabs. Realm defaults to Abelian's (`9341456741690479`) only when `QB_ENVIRONMENT=production`; else pass `--realm`.
