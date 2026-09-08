# GRN → Accounts Reconciliation

Finds which GRN transactions have **not** yet been moved to the accounts department.

A GRN is considered to have reached accounts once it appears in the Vendor Ageing report. This app
reads both monthly Excel reports, matches them, and lists what is still outstanding.

- **`01. GRN Report`** — every GRN raised in the month (the full population).
- **`02. Vendor ageing report`** — the bills that have reached accounts.

---

## Setup

### 1. Prerequisites
- Node.js 20 or newer (built and tested on 24)
- PostgreSQL 12 or newer (tested on 18)

### 2. Create the database

```sql
CREATE DATABASE yh_grn;
```

### 3. Configure

```bash
cp server/.env.example server/.env
```

Then edit `server/.env` and set:

| Variable | What to put |
|---|---|
| `DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/yh_grn` — replace `YOUR_PASSWORD_HERE` |
| `JWT_SECRET` | Already generated for you. Regenerate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

The server refuses to start if either is missing.

> **Port note:** the API defaults to **4100**, not the usual 4000, because another Node process was
> already listening on 4000 on this machine. Change `PORT` in `server/.env` if you would rather use 4000, and
> set `VITE_API_PORT` to match when running the client dev server.

### 4. Install and migrate

```bash
npm run install:all
npm run migrate
```

`migrate` creates the tables and seeds the login account. It is safe to run repeatedly.

### 5. Run

Two terminals in development:

```bash
npm run dev:server     # API on http://localhost:4100
npm run dev:client     # UI  on http://localhost:5173
```

Or as a single process:

```bash
npm run build          # build the React app
npm start              # API serves the UI on http://localhost:4100
```

**Sign in with `Admin` / `Admin@123`.** Change this by setting `SEED_ADMIN_PASSWORD` in `server/.env`
*before* the first `npm run migrate` (an existing user is never overwritten).

That seeded account is an **administrator**. Every other account is created from **User management**
in the sidebar — see [Accounts and access](#accounts-and-access) below.

---

## Accounts and access

**User management** in the sidebar is the administrator's screen: who has an account, what role it
carries, and which screens it may open. It is `/users`, and only an administrator sees it.

### The two roles

| | Administrator | Standard user |
| --- | --- | --- |
| Screens | All of them | Only the ones ticked for the account |
| User management | Yes | No |
| Correcting a GRNS SPAN date | **Yes** | No — read-only |

An administrator holds every screen whatever is stored against the row, so the account that hands
out access can never be locked out of a screen by the list it edits.

### Screen access

Three screens can be granted, keyed by the route they guard:

| Key | Screen |
| --- | --- |
| `upload` | New reconciliation |
| `results` | Reconciliation results, including the GRNS SPAN tab |
| `csd` | CS Department |

The list lives in `server/src/config/screens.js` and is sent down with the accounts, so the tick
boxes on the screen and the validation on the way back are one list rather than two that can drift.

An account is refused a screen in three places, and the last of them is the one that matters:

1. The sidebar does not draw a link to it.
2. `ProtectedRoute` redirects to a screen the account does hold, so following a bookmark or typing
   the address does not open it.
3. `requireScreen` on the server refuses the requests behind it — which is the actual boundary. The
   first two only keep the browser from opening a screen it cannot fill.

### Creating and changing accounts

Each account also carries a **Department** — `CSD` or `Accounts`, or left as *Not stated*. It is a
label on the person and nothing more: what an account may open is decided by the role and the screen
grants alone, so someone in the CSD department with only Results ticked still sees only Results.
Keeping the two apart means a reorganisation is a relabelling rather than a re-grant.

**New account** takes a username, a password (at least 6 characters), a role and the screens. The
username is what signs in and what past uploads are attributed through, so it cannot be changed
afterwards — everything else can. Usernames are compared case-insensitively, the same way signing in
matches them, so `kavitha` and `Kavitha` cannot both exist.

Each row carries four controls: edit, reset password, deactivate/activate, and delete.

- **Deactivate** is the one to reach for when someone leaves. It is checked on *every* request, not
  only at sign-in, so a session already open stops working immediately rather than when its token
  expires. The name stays against past uploads and handovers.
- **Delete** removes the account outright. What it did survives — uploads, handovers and stage
  changes all reference the user with `ON DELETE SET NULL` — with the name dropped from them.
- **Reset password** sets a new one without needing the old. Sessions already open keep working, so
  to cut one short, deactivate the account and activate it again.

Three things are refused, by the server rather than only by the screen: you cannot demote,
deactivate or delete the account you are signed in as, and the last active administrator cannot be
demoted or deactivated by anyone — either would leave the installation with no way to manage
accounts short of a database edit.

---

## How the matching works

The **GRN number** is the key. The ageing report stores it with the branch code attached
(`SE1BMWH0000782` = branch `SE1` + GRN `BMWH0000782`), so the branch code is stripped into its own
column and the remainder is matched against the GRN report's `DPR.No`.

Bill number is compared too, but a difference does **not** make a transaction pending — those rows
are matched and **flagged** so the difference stays visible. Vendor name is not compared: the two
systems spell it differently often enough — `MATRIX THERAPEUTICS PRIVATE LIMITED` in one, `MATRIX
THERAPEUTICS PVT. LTD.` in the other — that it is not a meaningful signal, so each row's vendor name
is left exactly as its own source report spells it.

Each GRN transaction lands in one of three buckets:

| Status | Meaning |
|---|---|
| **Pending** | The GRN number is not in the ageing report — **not yet with accounts**. |
| **Moved to accounts** | Found, and the bill number agrees. |
| **Needs review** | Found, but the bill number differs. Still with accounts. |

Ageing rows with no counterpart in the GRN report (carried-forward GRNs from earlier months) are not
reported, by design.

### Results for April 2026

| Status | Transactions | Value |
|---|---:|---:|
| Pending | 1,218 | ₹ 8,69,79,127.97 |
| Moved to accounts | 2,247 | |
| Needs review | 2 | |
| **Total checked** | **3,467** | ₹ 21,13,85,137.91 |

Pending by warehouse: PHRM 689, CSPH 309, BRDG 91, GSTR 43, BMWH 39, CIVS 36, EVNT 11.

Of the 94 flagged rows, 2 are genuine bill-number typos
(`HN00681`/`HR00681`, `236/25-27`/`236/26-27`) and 92 are vendor-name spelling differences.

---

## Using it

1. **Upload** — give the month a label (e.g. `Apr'26`), choose both reports, and submit. Parsing and
   matching several thousand rows takes a few seconds.
2. **Results** — opens on **Pending**. The three cards double as tabs. **Needs review** shows the GRN
   value beside the ageing value so a difference can be judged at a glance.
3. **Export** — downloads the currently selected tab as Excel or CSV. **The workbook is built in the
   browser**: the API answers with the rows as JSON and nothing else, so it never has to hold a
   workbook in memory or stream one out. Document numbers are written as text so Excel cannot mangle
   a bill number like `3610006395` into `3.61E+09`.

   **Pending downloads in the GRN report's own layout** — the same columns, in the same order, with
   the same header spelling — plus one **Remarks** column at the end, left blank for whoever chases
   the GRN to write in. Three source columns are dropped: `Location`, which holds the same company
   name on every row, and `DPR.Date` / `Bill.Date`, which are not what anyone chasing a pending GRN
   reads. A pending row has no ageing counterpart, so the ageing columns would only be empty, and
   the file goes back to the stores looking like the sheet they sent. The other two tabs keep the
   reconciliation layout — both sides of the match, dates included.

   The CSV gets no title row: a single cell above the header knocks every column out of alignment
   for anything reading the file as data rather than opening it in Excel.

Each upload is stored as its own batch under the name you give it, so previous uploads stay available in
the upload selector. The selector also carries an **All uploads** option, which reconciles every batch
together — the cards, tabs, table, turnaround statistics and exports all widen to cover the lot.

A GRN still pending when one month's report is taken is uploaded again with the next, so the same GRN
number appears in several uploads. The combined view keeps **one row per GRN number** and drops the
rest: the most recently uploaded copy wins, since it carries the latest state of that GRN. Within a
single upload the GRN number is already unique, so viewing one batch reads the table directly and pays
nothing for the deduplication.

### Searching

The toolbar carries a search box that filters the table by **vendor name**, **GRN number** or **bill
number** — a case-insensitive substring match, so `linde`, `CIVIL00161` and `YBMS/769` all find their
rows. Both sides of the match are searched: the two systems spell vendor names differently and number
the GRN differently again, so either spelling finds the transaction.

The search applies to whatever else is selected rather than replacing it. The stat cards, the tab
counts, the turnaround statistics and both exports all narrow to the same set, so the numbers on
screen always describe the rows on screen. It is debounced by 300ms, so typing a vendor name is one
request rather than one per keystroke.

### Correcting a stage date

The seven checkpoints are transcribed by hand into the source system, and some arrive wrong — a
mistyped year puts a bill decades out, a security date before its own PO makes a stage read negative.
Rather than re-uploading a corrected workbook, click any date under **Reached** on the GRNS SPAN tab
and pick a new one. `PATCH /api/ageing/:id/dates` writes it back; clearing the field records "not
reached yet".

**Only an administrator can do this.** For everyone else the same dates read as plain text with no
control on them — the figures are there to be read, and the correction is one person's call. The two
routes behind the tab (`PATCH /api/ageing/:id/dates` and `PATCH /api/csd/:id/dates`) are mounted
behind `requireAdmin`, so the rule holds whether or not the button was on screen.

The day counts are never stored — they are computed from the dates on every read — so a correction
needs nothing else told about it. The row's gaps, the stage medians and p90s, the data-quality counts
and both exports all recompute from the new date. Only those seven columns are writable; the rest of
an ageing row stays exactly as uploaded.

One thing to know: each upload stores its own copy of the ageing rows, so a correction applies to the
row in the upload you are looking at. In **All uploads** that is the most recent copy — the one the
deduplication keeps — which is the one on screen.

### How the Excel file looks

Like the source reports, the sheet opens with a **title row** — `GRN Pendings`, `GRN Needs Review`,
`GRN Moved To Accounts` — merged across the columns, with the header on row 2 and data from row 3.

| | |
|---|---|
| Title band | `#241B12` (`--umber-900`), white bold 14pt |
| Header band | `#F58633` (`--brand`), dark bold text, centred and wrapped |
| Row banding | `#FBEEDA` (`--brand-50`) on alternate rows |
| Gridlines | `#E0D5C2` thin, on every cell |
| Amounts | right-aligned, `#,##0.00`; `Sl.No` centred, `0` |
| Remarks | 42 characters wide, wrapping |
| Panes | header frozen, so it stays put while scrolling 1,200 rows |
| Print | landscape, fit to one page wide, header repeated on every page |

The colours are the app's own tokens, taken from the light-theme rungs in `client/src/styles.css`,
so a printed export and the screen it came from read as the same report. The header carries *dark*
text on the orange rather than white — white on `#F58633` is about 2.4:1, which does not survive a
photocopier.

**No autofilter is applied.** The dropdown arrows cover the header text, and a filter left switched
on is a good way to hand someone a sheet that silently hides rows. *Data → Filter* turns it on when
it is wanted.

---

---

## Turnaround — how many days each step takes

The **Turnaround** tab answers the second question the reports can settle: not *which* GRNs are
stuck, but *where* they get stuck. A bill passes seven dated checkpoints, so there are six gaps:

```
IndentDate → PO_Date → SecurityDate → GRN_Date → BillToAudit → BillHandOverToAcc → ChqDate
     PR→PO     PO→Sec      Sec→GRN      GRN→Audit    Audit→Acc        Acc→Cheque
```

All seven come from the **ageing report**. The GRN report has no counterpart for any of them, so a
pending GRN — one with no ageing row — has no turnaround at all. That is why the tab covers the
**2,249** matched GRNs rather than all 3,467, and why the two non-Pending cards light up when it is
selected: they are the population being measured.

### April 2026

| Stage | n | missing | backwards | Median | Average | p90 |
|---|---:|---:|---:|---:|---:|---:|
| PR → PO | 2,249 | 0 | 0 | **0** | 2.4 | 7 |
| PO → Security | 2,233 | 16 | 467 | **1** | 0.7 | 20 |
| Security → GRN | 2,233 | 16 | 0 | **1** | 10.5 | 4 |
| GRN → Audit | 2,249 | 0 | 0 | **3** | 3.8 | 8 |
| Audit → Accounts | 2,249 | 0 | 0 | **3** | 3.9 | 7 |
| Accounts → Cheque | 2,030 | 219 | 16 | **12** | 13.2 | 23 |

End to end, PR to cheque: median **24 days**, average 35.8, p90 64, over the 2,030 GRNs that have
reached a cheque.

**Accounts → Cheque is half the total.** The flow bar is sized by these medians so that lands
without reading a number.

### Why the median leads and the average does not

Two rows carry a mistyped year — `09-04-2006` and `07-04-2006` for what must be 2026 — which produce
gaps of about 7,300 days. That alone drags the Security → GRN **average** from 1 day to 10.5. The
median does not move. So the median is the headline on every card and in the bar; average and p90 sit
beside it, one size down, to keep the spread visible.

### The source report's own day columns are not used

The ageing report ships six pre-computed gaps (`IndentToPO`, `POToSeurity` [sic], `SecurityToGRN`,
`GRNToAudit`, `AuditToAcc`, `AccountsToChqDate`). They are ignored, and measuring them says why:
across all 3,200 April rows they are the **absolute value** of the gap, with zero written as blank.
Every blank corresponds to a true zero — no exceptions — and every disagreement with a computed gap
is exactly a sign flip. Trusting them would report 573 rows where `SecurityDate` precedes its PO as
ordinary positive durations.

Computing from the dates keeps the sign, and the sign is the interesting part.

### Dates that run backwards

478 rows have a step that finishes before it starts, and they are shown as measured — a negative
number in red — not clamped to zero and not dropped. Clamping would hide a real data-entry problem;
dropping would quietly shrink the population. The tab names both groups in a note above the table so
they can be fixed at source.

By stage: PO → Security 467, Accounts → Cheque 16, Security → GRN 0. `SecurityDate` is the
troublesome one: of the rows where it precedes the PO, 562 also have it *before the indent*, and it
sometimes equals the indent date exactly, while 2,459 rows do sit correctly between PO and GRN.
That looks like a question for whoever owns the ageing report rather than something to code around.

### Notes

- **A batch uploaded before this feature existed shows a "predates the turnaround report" notice.**
  The stage dates are read at upload time, so re-uploading that month's two reports fills them in.
- `bill_to_audit` and `bill_handover_to_acc` used to be stored as `TEXT` holding `dd-MM-yyyy`. They
  are `DATE` now — `npm run migrate` converts them in place and is safe to re-run. The **Handed To
  Accounts** column in the existing exports is unaffected: it is marked as a date column, so it
  still renders `dd-MM-yyyy` rather than the ISO form Postgres now returns.
- `Cheque_ClearanceDate` is stored but not reported on; a cheque → clearance stage is one line away.

---

## Verifying the install

```bash
npm run check-parse
```

Reads the two April 2026 files straight from the project root and asserts the figures above, without
needing the database. Use it after any change to the parser or matching rules — if the numbers move,
something broke.

---

## The look

The UI is staged like a photographed object: a dark drape of cloth as the room, and cast-concrete
slabs standing on it holding the numbers. Three generated SVGs do all of it — there are no photos and
nothing is fetched from a CDN, so it still renders on a hospital machine with no outbound internet.

| Asset | What it is |
|---|---|
| `bg-drape-dark.svg` / `bg-drape-light.svg` | The room. Folds of cloth lit from the top right, with the brand orange as the only light source. Fixed to the viewport so the page scrolls over a still background. |
| `wall-grain.svg` | The material. A seamless concrete tile, mid-grey on average, so it is *blended* into a surface colour rather than painted over it — one tile skins both the warm dark slabs and the pale plaster of the light theme. |

Every panel — cards, the table, the tab strip, the rail — is a slab: a lit chamfer along the top
edge, a shaded underside, and a hard unblurred lip beneath it that reads as real thickness. The lip
is what separates a card from the drape; a blurred shadow alone dissolves into a dark textured
ground. The login cube and the plinth it floats over are built in actual CSS 3D (six faces, each
rotated onto its own plane), so the browser does the perspective.

The full rationale lives at the top of `client/src/styles.css`. The drape plates are committed;
regenerate them only when retuning the folds:

```bash
npm --prefix client run gen:backgrounds
```

---

## Layout

```
server/
  src/services/excelParser.js   reads both .xls (BIFF8) and .xlsx
  src/services/normalize.js     comparison keys, branch-code split, date handling
  src/services/reconcile.js     the matching rule
  src/services/turnaround.js    stage day-gaps and their statistics
  src/services/ingest.js        bulk insert of a batch
  src/routes/                   auth, batches, results
  src/db/schema.sql             tables
client/
  src/pages/                    Login, Upload, Results
  src/components/               ResultsTable, TurnaroundView
  src/services/exporter.js      builds the Excel / CSV downloads in the browser
  src/api/client.js             fetch wrapper, token handling
  src/styles.css                design system: tokens, materials, shell, components
  src/assets/                   the drape plates and the concrete tile
  scripts/gen-backgrounds.mjs   regenerates the drape plates
```

---

## Troubleshooting: "The service is no longer running"

If the dev server starts fine but every file then fails with:

```
[vite] Internal server error: The service is no longer running
  Plugin: vite:esbuild
```

…or a build dies with `The service was stopped: write EPIPE`, that is **not** a problem with this
project's code. It is esbuild's helper process dying on this machine.

**What is happening.** esbuild does its work in a long-lived `esbuild.exe` child process. On this
machine that child is intermittently killed roughly a second after it starts — measured at about
**one spawn in six**, exit code 1, no error output. Vite starts the service **once** per dev server,
so a single killed spawn poisons the whole session: every later request fails until you restart it.

**What was ruled out.** Not the project config, and not Vite — a plain `node -e` script calling
`esbuild.transform()` in a loop reproduces it with no Vite involved. Not memory either: failing and
passing runs were measured at identical free RAM and commit charge. Windows Defender is disabled on
this machine and **Trend Micro Apex One** is the active endpoint protection, which is the most likely
culprit given the ~1 second lifetime, but its event log shows no matching block entry, so this is a
strong suspicion rather than a proven cause.

**What this project does about it.** esbuild cannot be removed from Vite outright — the `vite:define`
plugin and dependency pre-bundling both need it. So `vite.config.js` takes it off every hot path it
can, which cuts the number of spawns per run dramatically:

| Job | Stock Vite | Here |
|---|---|---|
| JSX | esbuild, per file | **SWC** (`@vitejs/plugin-react-swc`), in-process |
| JS minify | esbuild | **terser**, pure JS |
| CSS minify | esbuild | **lightningcss**, in-process native module |
| Chunk transpile | esbuild | skipped (`build.target: 'esnext'`) |

Measured over repeated runs, that took the dev server from failing about a third of the time to
**6/6 clean starts**, and builds from roughly half failing to 7/8. `npm run build` then wraps the
remainder in a retry (`client/scripts/build.mjs`), which only retries this specific transient failure
and lets real compile errors fail immediately — **10/10 builds succeeded**, one via retry.

**If it still happens.** Restart the dev server; a fresh service usually spawns fine. For a permanent
fix, ask IT to add an exclusion in Trend Micro Apex One for `D:\koti\YH-GRN` (or at minimum for
`client\node_modules\@esbuild\win32-x64\esbuild.exe`). To rule the AV in or out first, have them
disable behaviour monitoring briefly and run:

```bash
cd client
node -e "const e=require('esbuild');let n=0;const t=setInterval(async()=>{n++;try{await e.transform('const a'+n+'=1',{loader:'js'})}catch(x){console.log('died at '+n);process.exit(0)}if(n>=25){console.log('survived');process.exit(0)}},300)"
```

Run it ten times. If it never dies with the exclusion in place, the AV was the cause.

---

### Notes

- **Two Excel libraries, one for each direction.** The server *reads* with **SheetJS**, installed
  from `cdn.sheetjs.com` rather than npm — the npm copy is frozen at the deprecated `0.18.5` and
  carries prototype-pollution and ReDoS advisories, while the vendor build is maintained. It is
  needed because the GRN report is a legacy BIFF8 `.xls`, which ExcelJS cannot open.

  The client *writes* with **ExcelJS** (MIT). SheetJS could not do this job: its community build
  silently discards every cell style — set a fill and it round-trips back as
  `{"patternType":"none"}`, with no styles part written to the file at all — because styling is a
  SheetJS Pro feature. Freeze panes are the same story: the community writer emits `<sheetView>`
  with no `<pane>` child.

  ExcelJS is a dynamic `import('exceljs')`, so Vite emits it as its own ~930 kB chunk fetched only
  when someone presses Export; the bundle that must load before the login screen stays at ~254 kB.
  It is bundled, not fetched at runtime — nothing reaches a CDN from the browser.

  `npm audit` flags ExcelJS's `uuid@8.3.2` dependency (GHSA-w5hq-g745-h8pq, moderate). That
  advisory covers `v3`/`v5`/`v6` **when a `buf` argument is passed**; ExcelJS only ever calls
  `uuidv4()` with no arguments, in `cf-rule-ext-xform.js`, so the affected path is unreachable.
- **The client build never reads `server/.env`.** That file holds the database URL, the JWT secret
  and the seed password, none of which belong anywhere near a browser bundle. It sits in `server/`
  next to the only thing that reads it, so the API can be deployed on its own. The dev proxy defaults
  to port 4100; override with `VITE_API_PORT`.
- Both reports carry a title block above the header, and the header sits at a different row in each
  (row 2 vs row 6). The parser finds it by looking for the column names rather than assuming a row.
