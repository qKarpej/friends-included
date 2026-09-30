# Friends Included Ltd — finance system

*All friendships expire at checkout.*

A working finance system for a fictional wedding-guest agency. Employees report sales and expenses through **Telegram** or the **website**, the manager approves commission splits and expense allocations, and results update automatically. **Supabase** is the source of truth, **Google Sheets** gets a readable mirror, and **Vercel** hosts everything. No AI model or paid AI API is used at runtime: the rules are fixed code.

| Layer | What it does here |
|---|---|
| Telegram | `/sale`, `/expense`, `/mine`, `/start`; confirmations after saving; decision notifications to the **original chat** |
| Supabase | employees, Telegram links, transactions (proposal **and** final decision), hash-chained audit ledger |
| Vercel | website (role selector, forms, approvals, dashboard) and serverless API, including the Telegram webhook |
| Google Sheets | `Sales` and `Expenses` tabs, one row per reference, updated in place on approval or retry |

---

## What makes this submission different

1. **The brief is executable.** `lib/scenario.js` replays Test 1, Test 2, every rule-enforcement attempt, the interrupted-sync drills and a tampering attempt through the *real* processing layer, on an isolated in-memory copy. It runs on the live site (**Acceptance test** tab → 70/70 checks) and locally with `npm test`. The same scenario also runs through the real Supabase data-access code against a PostgREST imitation, so the database layer is tested too.
2. **Tamper-evident audit ledger.** Every submission, decision, refusal, denied attempt, link change and delivery result is a SHA-256 hash-chained entry. Edit or delete any `audit_log` row in Supabase and **Audit ledger → Verify again** points to the exact entry that was changed.
3. **Reconciliation bridge.** The dashboard draws the brief's reconciliation (Project A + Project B − overhead − awaiting = company) as a waterfall and checks it to the cent.
4. **Built-in failure drills.** Manager setup has switches that simulate a Google Sheets outage or a Telegram failure on the live system. Transactions still save, records honestly show *Sync failed* / *Not delivered*, and Retry writes to the same row.
5. **Permission probe.** The Acceptance test tab sends real forbidden requests as the current role and shows the server refusing them with the control totals unchanged. Hiding buttons is never the protection.
6. **Race-proof approvals.** Approval is a compare-and-set on "still pending", so a double click, a retry or two tabs approving at once can never double-count income, commission or an expense.
7. **Zero dependencies.** No npm packages at all: Google service-account JWT signing, PostgREST calls and the Telegram API use only Node's built-in `fetch` and `crypto`. There is nothing to install and nothing to go out of date.
8. **One rules file for server and browser.** `public/shared/rules.js` computes commissions for the server *and* for the live preview in the approval screen, so what Svetlana sees before clicking is exactly what gets saved.

---

## Setup (about 45 minutes, once)

You need free accounts on GitHub, Vercel, Supabase and Google Cloud, plus Telegram.

### 1. Telegram bot
1. In Telegram, open **@BotFather** → `/newbot` → choose a name and a username ending in `bot`.
2. Copy the **token**. It is secret and belongs only in Vercel environment variables.

### 2. Supabase
1. Create a project at supabase.com.
2. **SQL Editor** → paste the whole of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. This creates the tables, seeds the five employees and enables Row Level Security with no public policies.
3. **Project Settings → API**: copy the **Project URL** and the **service_role** key (secret).

### 3. Google Sheets (service account)
1. In Google Cloud Console, create a project, then **APIs & Services → Enable APIs** → *Google Sheets API*.
2. **IAM & Admin → Service Accounts → Create**, then open it → **Keys → Add key → JSON** and download it.
3. Create an empty Google Sheet. Share it with the service account's `client_email` as **Editor**. The app creates the `Sales` and `Expenses` tabs, headers and money formats itself.
4. Share the sheet with your instructor as **Viewer**. Never enable public editing.
5. The sheet ID is the long part of the URL: `docs.google.com/spreadsheets/d/<THIS>/edit`.

> If your institution blocks service-account keys, don't switch to manual copying. Note the exact error message and contact the instructor.

### 4. GitHub → Vercel
1. Push this folder to a new GitHub repository. `.gitignore` already keeps secrets out.
2. On vercel.com: **Add New → Project** → import the repository. The framework preset is *Other*, and no build command is needed.
3. **Settings → Environment Variables**: add every name from [`.env.example`](.env.example). For `GOOGLE_PRIVATE_KEY`, paste the `private_key` value from the JSON file (it contains `\n` sequences; that's fine).
4. Redeploy.

### 5. Register the Telegram webhook
Run once, replacing the URL and secret. In PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "https://YOUR-APP.vercel.app/api/admin?action=set-webhook" -Headers @{ "x-admin-secret" = "YOUR_ADMIN_SECRET" }
```

The same thing with bash or curl:

```bash
curl -X POST "https://YOUR-APP.vercel.app/api/admin?action=set-webhook" -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

To check it: `?action=webhook-info`. To remove practice data before Test 1 (this deletes all transactions and ledger entries and clears the sheet rows; employees and links are kept): `?action=reset`.

---

## Running the two tests on the live system

**Test 1**
1. Open the bot and press **Start**. It replies with your Telegram user ID.
2. Website → role **Svetlana** → **Manager setup** → link your ID to **Richard**.
3. In Telegram: `/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20`
4. Manager setup → link your ID to **Kevin**.
5. In Telegram: `/expense E01 | Rented suit and fake pearl necklace for the relatives | 120 | Materials | A`
6. Website as **Anastasia** → New sale S02. As **Kevin** → New expense E02 (B) and E03 (Company overhead).
7. As **Svetlana** → **Approvals**: approve S01 as proposed; change S02 to 20/40/40 and approve; confirm E01 to A; move E02 to A and approve.
8. Your Telegram receives the S01 and E01 decisions (original chat) and E02 (Kevin is linked). S02 shows *No Telegram recipient linked*.
9. The dashboard should show €700 / €1,800 / €2,400, and commissions of €90 / €110 / €100.

**Test 2**: enter S03–S05 and E04–E07 on the website with the matching roles. Link **Jean-Claude** and approve S03 at 20/30/50 (the notification shows €30 / €45 / €75). Approve S04. Link **Kevin**, confirm E04 and move E05 to B. Leave S05 and E07 pending. The dashboard should show €2,050 / €2,180 / €3,930, and **Acceptance test → Live data vs the brief** should show a full match.

**Integration checks**: in Manager setup, turn on *Simulate Google Sheets outage*, submit something, see *Sync failed*, turn it off and press **Retry**. The same row appears once. Do the same with *Simulate Telegram failure*. Delete or reverse drill transactions only while you are still practising. The instructor's own extra transactions should, and will, change the results.

---

## Local development

```bash
npm run dev
```

This opens http://localhost:3000 in in-memory demo mode when no Supabase variables are set. `POST /__bot {"from":"123","text":"/start"}` simulates a Telegram message locally.

```bash
npm test
```

This runs the acceptance scenario twice (in-memory, and through the Supabase repository code).

## Where things are

```
api/            Vercel functions: action, state, config, ledger, selftest, telegram (webhook), admin
lib/service.js  processing layer: permissions, validation, idempotent decisions, sync, notifications
lib/bot.js      Telegram conversation (identity from Telegram user ID only)
lib/sheets.js   Google Sheets upsert by reference (service-account JWT, no SDK)
lib/ledger.js   hash-chained audit ledger + verification
lib/scenario.js the homework brief as an executable acceptance test
public/         website (index.html, app.js, styles.css) and shared/rules.js (commission maths)
supabase/       schema.sql
```

## Rules implemented (summary)

- Commission pool = 10% of the sale, rounded to the cent. Shares run from 0–100% and must total exactly 100%. Each share is floored to the cent and the leftover cent(s) go to the largest share (ties: Richard → Anastasia → Jean-Claude), so the parts always add up to the pool. The database enforces this too.
- A pending sale appears in the records but is excluded from income and commission. Approval adds both the sale and its final commissions.
- Every saved expense reduces the company result immediately. Overhead is allocated automatically. A/B proposals wait for Svetlana, and approving assigns the expense without deducting it twice.
- References are unique across sales and expenses, case-insensitively. Amounts must be > 0. Missing fields are refused with an explanation.
- The original proposal and the final decision are both stored. Approving twice changes nothing.
- Notifications go to the chat that submitted via the bot. Website entries go to the submitter's linked chat, or the record shows *No Telegram recipient linked*. Delivery is tracked separately from the decision.

## Security

Bot token, service-role key, Google private key, webhook secret and admin secret live **only** in Vercel environment variables. The browser never receives them, the repository contains none, and Supabase RLS blocks the public key entirely. All people and transactions are fictional.
