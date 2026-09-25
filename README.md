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

These screens can be granted, each keyed by the route it guards:

| Key | Screen |
| --- | --- |
| `upload` | New uploads |
| `results` | Results, including the GRNS SPAN tab |
| `accounts-department` | Accounts Department |
| `csd` | CS Department |
| `config` | Configuration |
| `vendor-master` | Vendor Master (see [Vendor Master](#vendor-master)) |
| `msme-reco` | HIS vs FOCUS Reco (see [HIS vs FOCUS Reco](#his-vs-focus-reco)) |
| `users` | User management |
| `logs` | Activity logs |

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

There is no choosing an upload. The results and Accounts screens always show every upload together:
the cards, views, table, turnaround statistics and exports all cover the lot.

A GRN still pending when one month's report is taken is uploaded again with the next, so the same GRN
number appears in several uploads. The database keeps **one copy of each GRN**: an upload replaces
what is stored for the GRNs it carries instead of adding a second copy, and anything it says nothing
about stays as it was.

- **GRN report** — a GRN's row is replaced by the new report's row.
- **Vendor Ageing report** — a GRN's ageing rows are replaced as a whole group. The report lists a GRN
  once per cheque and adds rows as payments are made, so the new report's rows are its current
  payment picture. A hand-typed cheque clearance date carries over to the new row for the same
  cheque.
- **Bank statement** — a transaction the new statement also carries (same dates, reference,
  narration, amounts and closing balance) keeps only the new statement's copy.
- **BPAD register** — a GRN's register rows are replaced, as before.

Each GRN has one reconciliation result, rebuilt whenever an upload brings either side of it. So the
two reports pair up whichever order they arrive in. A GRN paid by several cheques is paired with its
first ageing row, which carries NetAmt and the payable amount.

Uploading the same report again therefore stores no second copy. Only the values that moved change.
The upload itself is still recorded. CSD and Records handovers are keyed on the GRN number, so they
survive, with one exception: a handover CSD **rejected** is reopened whenever an upload carries that
GRN again, even the same file. It is archived with CSD's reason, taken off the queue, and the GRN
reads as unsent. Rows stored before this rule existed are cleaned up by `npm run migrate`: the
newest copy of each GRN is kept, and each upload's other files stay.

There is no Uploaded files screen and no deleting an upload. Each GRN is shown once, with its latest
data, so there are no uploads to manage one by one.

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

One thing to know: the GRNS SPAN tab no longer offers this for the ageing report's own dates, which
are corrected at source. Only `PATCH /api/ageing/:id/dates` still writes them. The next Vendor Ageing
report that lists the GRN replaces its stored rows with the report's own dates, so a stage date
written that way doesn't survive it. A cheque clearance date written that way does survive: it
isn't one of the report's columns, so it carries over to the new row for the same cheque.

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

## HIS vs FOCUS Reco

**HIS vs FOCUS Reco** sits under its own dropdown in the sidebar, **Vendor Reco**, and has its own
screen grant. It compares the HIS vendor master with the FOCUS (Accounts) vendor list and shows,
vendor by vendor, where the two disagree.

It started out as the "MSME reco". That name is still used for the route (`/msme-reco`), the screen
key (`msme-reco`), the API (`/api/msme-reco`) and the tables (`msme_reco_*`). Renaming those would
change a URL and a stored grant for no visible gain.

- **`00. VendorMasterReport from HIS`**: the vendor master. The workbook has an **All** sheet
  (every vendor, inactive ones included) and an **Active** sheet. **Active** is read when the
  workbook has one; otherwise the first sheet with the header is. The screen names the sheet it read.
- **`02. 010Account`**: the Accounts vendor list. Its header is on row 4, under a title, a group
  band and a row of internal names. The parser finds it by the column names.

Upload both files with **New reco**. There is no choosing a reco: the screen shows every vendor at
once, **each vendor once**, from the latest reco that included it. Uploading the same files again
replaces those vendors' rows instead of adding a second set. A vendor that the latest file no
longer lists keeps its last reco's result. The line over the table describes the latest reco, and
each row's **Reco date** says which reco it came from. The HIS vendor master file is also applied
to the [Vendor Master](#vendor-master): new vendors are added and the rest are updated.

There is no Delete. Nothing piles up that would need removing: the screen shows each vendor once,
and the Vendor Master keeps one row per vendor.

### How the matching works

Vendors are matched on **vendor code**: `VENDOR_CODE` in the vendor master, `Code` in Accounts. The
match is exact after trimming, folding repeated spaces to one, and upper-casing. Ignoring
separators (as the GRN matching does) found no extra matches in the sample files, and it would have
merged 16 pairs of different Accounts codes.

For every matched vendor, these pairs are compared:

| Field | Vendor master | Accounts | Compared as |
|---|---|---|---|
| Vendor Name | `VENDOR_NAME` | `Name` | name |
| PAN No | `PAN_NO` | `PAN No` | identifier |
| GST No | `GST_NUMBER` | `GSTIN` | identifier |
| Drug Licence No | `DRUG_LICENCE_NO` | `Drug Licence No` | identifier |
| MSME No | `MSME_NUMBER` | `MSME Reg No` | identifier |
| MSME Type | `ENTERPRISE_TYPE` | `MSME Type` | identifier |
| MSME Activity | `ENTERPRISE_ACTIVITY` | `MSME Activity` | identifier |
| Bank Account No | `BANK_ACCOUNT_NO` | `Bank Account Number` | account |
| IFSC | `IFSC` | `Bank IFSC Code` | identifier |
| Payee Name | `PAYEE_NAME` | `Bank Account Name` | name |

- **Identifier:** case, spaces and separators are ignored, so `AICP L8904E` equals `AICPL8904E`.
  Every letter and digit must still agree.
- **Name:** also ignores punctuation, spacing, `&`/`AND`, `PVT`/`PRIVATE`, `LTD`/`LIMITED` and a
  leading `M/S`. So `S.V.ELECTRONICS` equals `S V ELECTRONICS`, but `DAMANI` and `DAMMANI` are still
  a mismatch.
- **Account:** compared like an identifier. If the only difference is leading zeros, the remark says
  so.
- **Placeholders** count as blank in every field: dashes or dots, a value made only of zeros, `NA`,
  `N/A`, `NIL`, `NULL`, `NONE`, `Not Applicable`, and Accounts' own "no number" markers:
  `Unregistered` in GSTIN, and `PAN Applied` or `No Pan` in PAN. Two blanks agree, so a blank
  `GST_NUMBER` against `Unregistered` is a match. A value on one side only is reported as
  *missing in FOCUS* or *missing in HIS*.

> **Payee Name** is compared with Accounts' `Bank Account Name`, not its `Bank Name`. `Bank Name`
> holds the bank itself ("STATE BANK OF INDIA"). Against `PAYEE_NAME` it matched 0 of the 1,724
> shared vendors, while `Bank Account Name` matched 1,349. The pairing is one line in `FIELDS` in
> `server/src/services/msmeReco.js` if it ever needs to change.

**Every HIS vendor is stored**, one row each, with one of three statuses:

| Status | Meaning | Remarks |
|---|---|---|
| **Matched** | Code in both files; every field agrees | `All details match` |
| **Mismatch** | Code in both files; at least one field differs | Every difference, e.g. `PAN No mismatch, MSME No missing in FOCUS` |
| **Not in FOCUS** | Vendor code not in the FOCUS (Accounts) list | Also names the FOCUS code with the same PAN or GSTIN, when there is one |

On screen, in the Excel file and in the remarks, the Accounts side is called **FOCUS**, the system
the Accounts list comes from.

**Accounts codes that are not in the HIS vendor master are counted, not stored.** The count is kept
on the run in `msme_reco_runs`, and the screen shows the latest reco's count in a note. These codes
are most of the Accounts ledger (land, labour and staff accounts, and so on), so storing them would
mean about 29,000 rows per run with no remark to read. `npm run migrate` removes any such rows left
over from runs stored before this rule.

If Accounts lists a code more than once, the vendor is compared with the first row and the remark
says how many there were.

### The screen and the Excel file

The cards pick a view: **HIS vendors** (the default: every vendor master row), **Mismatched**,
**Matched** and **Not in FOCUS**. Under them, **Mismatches by field** counts each field's
differences. Press a chip to see only those vendors. The search box looks at the code, name, PAN and
GSTIN on both sides.

When you scroll sideways, **Vendor Code, Status and the Vendor Name pair** (HIS and FOCUS) stay
fixed on the left. Warehouse slides under them. On windows narrower than 1280px only Vendor Code
and Status stay fixed, because four frozen columns would take up most of the table.

The table on screen is laid out like the Excel file: Vendor Code, Warehouse and Status, then each
field as an HIS column and a FOCUS column under a band naming the field, then Remarks and **Reco
date**. The header uses the app's own theme, light or dark, like every other table. Values that
differ are marked in pale red with bold dark-red text.

**Export Excel** downloads one workbook with a sheet for each card, in the cards' order and under
their names: **HIS vendors**, **Mismatched**, **Matched** and **Not in FOCUS**. A search on screen
narrows every sheet, and its text goes into the file name. The field chips don't affect the export,
because applied to every sheet they would leave **Matched** empty. On each sheet, each field is a
pair of columns headed with the source files' own column names (`PAN_NO (HIS)`, `PAN No (FOCUS)`)
under a band naming the field, followed by **Remarks** and **Reco date**. The sheets are plain:
bold headers, frozen above the data, and no colours. The Remarks column says what differs.

### Sample files (September 2026)

| | Vendors | Stored |
|---|---:|:---:|
| HIS vendors (Active sheet) | 1,897 | |
| — In both files, all details match | 580 | yes |
| — In both files, details differ | 1,144 | yes |
| — Not in FOCUS | 173 | yes (72 of them name a FOCUS code with the same PAN or GSTIN) |
| Accounts codes not in HIS | 28,822 | count only |

A run of these files stores 1,897 rows, one per HIS vendor.

```bash
npm run check-msme
```

This reads both sample files from the project root and checks those counts, including the number of
rows a run stores, without the database.

## Vendor Master

**Vendor Master** is the first link under the **Vendor Reco** dropdown, with its own screen grant
(`vendor-master`). The HIS vendor master is the correct data. HIS vs FOCUS Reco shows what needs
changing in the FOCUS (Accounts) vendor list to match it, and this screen shows the HIS vendor
master itself: every vendor it has ever listed, **once each**, with its latest details.

It has no upload of its own, and nothing can be deleted from it. Every time a reco is run, the HIS
vendor master file uploaded with it is applied to the master:

- **A vendor code already in the master** is updated with the file's values. Every column the file
  has takes the file's value, a blank included. A column the file doesn't have keeps its last value.
- **A new vendor code** is added.
- **A vendor missing from the file** stays in the master as it was.
- **A code listed twice in one file:** the last row is used.

Codes are matched the way the reco matches them: trimmed, repeated spaces folded to one, and
upper-cased. Uploading the same file again only updates the values that changed.

The master reads the file's **All** sheet when the workbook has one with vendors in it, so a vendor
switched off in HIS arrives with `STATUS` INACTIVE rather than simply going missing. Otherwise it
reads the same sheet as the reco, which still reads **Active**. Every labelled column is kept under
the file's own name. A repeated name gets a number (`REMARKS (2)`), and a row with no `VENDOR_CODE`
is skipped. Dates read as `dd/mm/yyyy`, and long numbers such as bank account numbers are written
out in full.

After each reco, both screens say what it did to the master, for example *12 new, 30 updated, 1,855
unchanged*.

Recos are applied to the master one at a time, in the order they arrive. If two are uploaded
together, the second waits for the first, so the latest file always wins. The newest file also sets
the column order: its own columns first, then any column only an earlier file had.

The tables are:

- `vendor_master`: one row per vendor, its details as JSON keyed by column name, its cleaned MSME
  number (`msme_no`), and the two details set on the screen: `supply_type` (REGULAR by default, or
  STENTS) and `inter` (NO by default, or YES).
- `vendor_master_columns`: the column order.
- `vendor_master_applies`: one row per file applied: which reco, which sheet, and how many vendors it
  added, updated or left unchanged.

**MSME No, MSME Status, Inter and Supply Type on the GRN screens come from here.** That covers every
GRN table (Total GRNS, Pending, Accounts, BPAD, PR-to-Bank and the CS Department queue), the MSME
filter and the exports. Each looks up the GRN's vendor code in the master, matched the same way:

- **MSME No** is the vendor's `MSME_NUMBER`, cleaned the way the reco cleans values, so `NA`, `-`
  or `Not Applicable` counts as no number.
- **MSME Status** is **MSME** when the vendor has a number and **Non-MSME** when it doesn't.
- **Inter** and **Supply Type** are what is picked for the vendor on this screen.
- **A vendor the master doesn't have** shows a dash in all four.

Nothing is copied onto the GRNs. The four are looked up on every page load, so a change here shows on
every GRN of that vendor straight away, both stored GRNs and future uploads. So does a new reco. A
vendor that a later file leaves out keeps the number it last had.

**Recos not yet applied** are applied oldest first by `npm run migrate`, when the server starts, and
before each new reco. On the first migration, that means every reco run before the Vendor Master
existed. It also covers a reco uploaded through a server that was still running older code after
the migration. Their files weren't kept, so they can only bring the 13 columns the reco stores
(`VENDOR_CODE`, `WAREHOUSE`, `STATUS`, `VENDOR_NAME`, `PAN_NO`, `GST_NUMBER`, `DRUG_LICENCE_NO`,
`MSME_NUMBER`, `ENTERPRISE_TYPE`, `ENTERPRISE_ACTIVITY`, `BANK_ACCOUNT_NO`, `IFSC`, `PAYEE_NAME`). A
late one never overwrites details a newer file already brought. Until a reco has brought a whole
file, the screen says only those columns are there. The first such reco will count many vendors as
updated, because it brings the columns and raw values the older runs couldn't.

**To upgrade:** stop the server, run `npm run migrate`, then start it again. Don't upload or run a
reco while the migration is running.

The table shows the file's columns under their own names, except `CREATED_DATE`, which is kept but
not shown, exported or searched. `VENDOR_CODE` and `VENDOR_NAME` come first and stay fixed on the
left when you scroll sideways. Two columns follow them, each picked on this screen from a dropdown
and saved at once:

- **Inter**: **No** or **Yes**.
- **Supply Type**: **Regular** or **Stents**.

Every vendor starts as **No** and **Regular**, including those a later reco adds, until someone picks
otherwise.

No file carries either, so a later reco never changes them. Each change is recorded in the activity
log under **Vendor Master**, with the value before (`PATCH /api/vendor-master/:id`).

The search box looks in every column shown, Supply Type included. If the files use more than one
`STATUS` value, there is a card for each. **Export Excel** downloads the vendors on screen, with the
card and the search applied, as one plain sheet laid out like the screen.

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
