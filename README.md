# quickbooks-cli

Read-only CLI for QuickBooks Online: chart of accounts, raw queries, reports (P&L, balance sheet, GL, ...), changed-transaction feeds, and a best-effort bank-feed snapshot. Built for both humans (`--pretty`) and LLM agents (JSON envelope).

## The read-only guarantee

Intuit has **no read-only OAuth scope** — `com.intuit.quickbooks.accounting` can write. Read-only is therefore enforced in this client:

- The HTTP layer (`src/http.ts`) is the only module that talks to the API, and it **refuses everything except `GET`, plus `POST` to the `/query` and `/text` endpoints** (the query language may be POSTed as plain text — still a read).
- There are **no create/update/delete code paths anywhere** in this tool. Attempting any other verb/endpoint throws `READ_ONLY_VIOLATION` before a request is made.

## Prerequisites

- Node.js >= 20
- An Intuit developer account + app (below)
- For `bankfeed` only: `agent-chrome` on PATH and Chrome running with `--remote-debugging-port=9222`, logged in to qbo.intuit.com

## Intuit app setup

1. Create a developer account at [developer.intuit.com](https://developer.intuit.com), then a Workspace and an app with the **`com.intuit.quickbooks.accounting`** scope. The free "Builder" tier allows 500k read calls/month.
2. Under **Keys & credentials (Development)**, copy the sandbox Client ID/Secret and add the redirect URI `http://localhost:3456/callback`.
3. Every developer account gets a **sandbox company** — use it first (`QB_ENVIRONMENT=sandbox`; the sandbox realm ID shows on the sandbox page, and `auth` captures it from the callback anyway).

### Production keys

For a private internal app there's no marketplace review, but you must:

1. Complete the **app details checklist**, the **self-attested security questionnaire**, and accept the ToS on the app's Production tab (~1 day of questionnaire latency).
2. Register a **public HTTPS redirect URI** — localhost is sandbox-only. A one-off static callback page on any domain you own suffices (it just needs to show you the URL you landed on).
3. Put the production Client ID/Secret in `.env`, set `QB_ENVIRONMENT=production` and `QB_REDIRECT_URI=https://your-callback-page`, authorize in a browser as a QBO admin, then paste the full redirect URL you land on:

   ```bash
   # prints the authorize URL — or build it yourself; then:
   quickbooks-cli auth --from-url "https://your-callback-page/?code=...&state=...&realmId=..."
   ```

## Setup

```bash
cd ~/tools/quickbooks-cli
npm install
npm run build
cp .env.example .env   # fill in QB_CLIENT_ID, QB_CLIENT_SECRET, QB_ENVIRONMENT
quickbooks-cli auth    # or: node bin/quickbooks-cli.js auth
```

`auth` starts a callback server on `localhost:3456`, opens the Intuit consent page, exchanges the code, captures the **realm ID** (company ID) from the callback, and offers to write it to `.env` if `QB_REALM_ID` is unset. Tokens land in `tokens.json` (gitignored, `chmod 600`).

### Environment variables (`.env`)

| Var | Meaning |
|---|---|
| `QB_CLIENT_ID` / `QB_CLIENT_SECRET` | Intuit app keys (sandbox or production set, matching `QB_ENVIRONMENT`) |
| `QB_ENVIRONMENT` | `sandbox` (default) or `production` — selects the API base URL |
| `QB_REALM_ID` | Company to query (falls back to the realm captured in `tokens.json`) |
| `QB_REDIRECT_URI` | Optional; defaults to `http://localhost:3456/callback`. Must match the app's registered redirect URI |

Base URLs: `https://sandbox-quickbooks.api.intuit.com` / `https://quickbooks.api.intuit.com`; all calls hit `/v3/company/{realmId}/...` with `minorversion=75`.

## Token lifecycle (important)

- **Access token: 60 minutes.** Auto-refreshed transparently before any command (and once more on a 401).
- **Refresh token: 100-day rolling window, but its VALUE rotates ~every 24h.** After every refresh this tool atomically overwrites `tokens.json` with the newest refresh token — if a rotated value is ever lost, the session is stranded and you must re-run `auth`.
- Run a **daily cron refresh** as a backstop so the window never lapses even when the CLI sits unused:

```cron
# crontab -e  (use an absolute node path — cron doesn't load nvm)
17 6 * * * cd $HOME/tools/quickbooks-cli && $HOME/.nvm/versions/node/v20.10.0/bin/node bin/quickbooks-cli.js auth --refresh >> /tmp/quickbooks-refresh.log 2>&1
```

(Or drop a one-liner script in `~/cron/daily/`.) Check health any time with `quickbooks-cli auth --status`.

## Output format

Single-line JSON envelope on stdout, human diagnostics on stderr, exit 0/1:

```json
{"ok": true, "data": {...}}
{"ok": false, "error": "message", "code": "ERROR_CODE"}
```

Add `--pretty` (before or after the subcommand) for human tables.

## Commands

### `auth`

```bash
quickbooks-cli auth                 # one-time browser OAuth (localhost:3456 callback)
quickbooks-cli auth --refresh       # refresh now; persists the rotated refresh token (cron this)
quickbooks-cli auth --status        # token ages/expiries, no network
quickbooks-cli auth --from-url URL  # complete auth from a pasted redirect URL (production)
```

### `company`

```bash
quickbooks-cli company --pretty     # CompanyInfo for the configured realm
```

### `accounts`

Chart of accounts with balances (queries `Account`).

```bash
quickbooks-cli accounts --pretty
quickbooks-cli accounts --all       # include inactive accounts
```

### `query`

Raw passthrough of QBO's SQL-ish query language with automatic `STARTPOSITION`/`MAXRESULTS` pagination (1000/page). If your query already contains either keyword it is sent as-is; `SELECT COUNT(*)` returns `totalCount`.

```bash
quickbooks-cli query "SELECT * FROM Purchase WHERE TxnDate > '2026-06-01'"
quickbooks-cli query "SELECT COUNT(*) FROM Invoice"
quickbooks-cli query "SELECT * FROM Vendor" --max 200
```

### `entity`

Fetch any entity by id.

```bash
quickbooks-cli entity Invoice 123
quickbooks-cli entity JournalEntry 45
```

### `txns`

Changed transactions via the CDC (change data capture) endpoint across `Purchase, Deposit, Transfer, JournalEntry, Bill, BillPayment, Invoice, Payment, VendorCredit`. **CDC only covers the last 30 days** — the CLI validates this and points you to `query` for older history. Deleted rows carry `status: "Deleted"`.

```bash
quickbooks-cli txns --since 30d
quickbooks-cli txns --since 2026-06-15 --entities Invoice,Payment
```

### `report`

Reports API (GET, read-only). Kebab-case names map to Intuit report names:

`profit-and-loss`, `profit-and-loss-detail`, `balance-sheet`, `general-ledger`, `trial-balance`, `cash-flow`, `transaction-list`, `transaction-list-with-splits`, `aged-receivables`, `aged-receivable-detail`, `aged-payables`, `aged-payable-detail`, `account-list`, `vendor-expenses`, `customer-income`. Unknown names pass through as PascalCase with a warning.

```bash
quickbooks-cli report profit-and-loss --start 2026-04-01 --end 2026-06-30 --pretty
quickbooks-cli report profit-and-loss --detail --date-macro "Last Fiscal Quarter"
quickbooks-cli report balance-sheet --accounting-method Cash
quickbooks-cli report general-ledger --start 2026-04-01 --end 2026-06-30 --param columns=account_name,subt_nat_amount
quickbooks-cli report profit-and-loss --date-macro "This Fiscal Year-to-date" --testing-migration
```

**⚠ Reports modernization cutover: Aug 31, 2026.** Intuit is changing 13 response-format behaviors in the Reports API. Test parsers early with `--testing-migration` (adds `testing_migration=true`) so nothing breaks at the hard cutover.

### `bankfeed` (best-effort, unofficial)

The official API **cannot see** bank-feed "For Review" transactions or per-account bank vs. book balances. `bankfeed` fills the gap by shelling out to `agent-chrome` and running same-origin/CORS fetches **inside an already-logged-in qbo.intuit.com tab** (it evals in place and never navigates your tabs). As of mid-2026 the original `qbo.intuit.com/api/neo/v1/company/{realm}/olb/ng/getInitialData` endpoint returns HTTP 500 for eval-context fetches; it's still tried first, then the tool falls back to `vault.api.intuit.com/v2/search/connections` (connected accounts + live bank balances) and `accounting-txn-svcs.api.intuit.com/.../banking/getTransactions` (the For Review queue). Expect breakage whenever Intuit changes these internal endpoints; degrade paths give clear errors when Chrome/agent-chrome/a logged-in tab is missing.

**Known limitations (honesty badge):**

- The fallback fetches depend on two **public QBO web-app API keys hardcoded in `src/commands/bankfeed.ts`** (`VAULT_APIKEY`, `TXN_APIKEY`). These ship in Intuit's browser bundle (not user secrets) but can rotate; when they do, bankfeed reports `NOT_LOGGED_IN`/`BANKFEED_ENDPOINT_ERROR`. Refresh them from a devtools capture of the QBO banking page (`Authorization: Intuit_APIKey intuit_apikey=…`).
- Per-account For Review counts can't always be auto-joined to named accounts: the vault endpoint keys accounts by FDP urn/`nickName` while txn-svcs tags items by `qboAccountId`, and there's no reliable shared key between them.

```bash
quickbooks-cli bankfeed --pretty            # realm defaults to Abelian's when QB_ENVIRONMENT=production
quickbooks-cli bankfeed --realm 9341456741690479
quickbooks-cli bankfeed --raw               # include the full raw payload (for shape changes)
```

Returns per-account `qboBalance`, `bankBalance`, `numTxnToReview`, `unmatchedCount`, `lastUpdateTime`.

## Rate limits

QBO allows 500 requests/min/realm. On `429` the client retries with exponential backoff + jitter (max 3 retries, honoring `Retry-After`).

## Architecture

- TypeScript + commander, ESM. `src/http.ts` is a thin hand-rolled `fetch` client (house style); the official [`intuit-oauth`](https://www.npmjs.com/package/intuit-oauth) package is used **only** for the OAuth2 token dance.
- `src/auth.ts` — OAuth flow, token persistence (`tokens.json`, atomic write, 0600), transparent refresh.
- `src/commands/*.ts` — one file per command.
- Design doc: `~/projects/asc/plans/85-quickbooks-cli.md`.
