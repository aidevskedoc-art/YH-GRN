-- GRN to Accounts reconciliation schema.
-- Safe to run repeatedly: every statement is guarded with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  -- ADMIN reaches every screen, manages the other accounts and is the only role
  -- allowed to correct a date on the GRNS SPAN tab. USER reaches exactly what
  -- `screens` lists and reads those dates without changing them.
  role          TEXT NOT NULL DEFAULT 'USER',
  -- Which screens a USER may open, by screen key -- SCREENS in
  -- config/screens.js is the list. Empty for a new account until an admin
  -- ticks something. Ignored for an ADMIN --
  -- see screensFor() in config/screens.js -- so the administrator cannot be
  -- locked out of a screen by unticking it.
  screens       TEXT[] NOT NULL DEFAULT '{}',
  -- Which department the person belongs to: HOSPITAL, OP_PHARMACY, CSD or
  -- ACCOUNTS (DEPARTMENTS in config/screens.js). A label, not a
  -- permission -- what an account may open is decided by role and screens above
  -- and nowhere else. Nullable, because an account whose department nobody has
  -- stated should read as unstated rather than be filed under a guess.
  department    TEXT,
  -- The one branch this account may see, by the location name the branch is
  -- configured under (branch_configs.location). NULL is every branch, which is
  -- what an unrestricted account and every account predating this column has.
  --
  -- Unlike `department` above, this IS a permission: it is applied to every
  -- query behind the results and CSD screens, not offered as a filter the
  -- person can clear. Ignored for an ADMIN -- see branchFor() in
  -- config/screens.js -- for the same reason `screens` is: the account that
  -- hands out access cannot be shut out by it.
  --
  -- Held as the location text rather than as a foreign key to branch_configs,
  -- because that is what the two reports are matched by: the ageing report
  -- knows a DivisionCode and the GRN report writes the location inside a longer
  -- string, and the branch row is what ties those two spellings to this name.
  -- Deleting a branch therefore leaves the grant naming a place that is no
  -- longer configured, which selects nothing -- an account that can see one
  -- branch's rows should stop seeing them when that branch stops existing.
  branch_location TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Screen access for a users table created before it existed. Every account that
-- predates this column is an ADMIN (the old default), so it reaches everything
-- regardless and the empty array below costs it nothing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS screens TEXT[] NOT NULL DEFAULT '{}';

-- The default used to be ADMIN, from when the seeded administrator was the only
-- account. Now that accounts are created from the user management screen, a row
-- created without a role stated is a standard user. Existing rows keep the role
-- they already carry.
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'USER';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'USER'));
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;

-- Branch access for a users table created before it existed. Null on every
-- existing row, which is "every branch" -- adding the column must not quietly
-- narrow what anybody could already see.
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_location TEXT;

-- NULL passes a CHECK, so "not stated" needs no exemption spelled out here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_department_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_department_check
      CHECK (department IN ('HOSPITAL', 'OP_PHARMACY', 'CSD', 'ACCOUNTS'));
  END IF;
END $$;

-- HOSPITAL and OP_PHARMACY joined CSD and ACCOUNTS later. A database that
-- already has the check from before they did still has the narrower one, which
-- the block above never revisits -- so it is dropped and put back with every
-- department in it. Nothing stored can fail it: the list only grew.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_department_check;
ALTER TABLE users ADD CONSTRAINT users_department_check
  CHECK (department IN ('HOSPITAL', 'OP_PHARMACY', 'CSD', 'ACCOUNTS'));

-- Sign-in matches on lower(username), so uniqueness has to be measured the same
-- way. The UNIQUE on the column itself is case-SENSITIVE, which would let
-- "kavitha" and "Kavitha" both exist and then have the login query return two
-- rows for either spelling -- authenticating whichever one Postgres happened to
-- put first. This index is the constraint that actually matches the lookup.
--
-- Guarded rather than created outright: on a database that already carries such
-- a pair the CREATE would abort the whole migration, and failing to start is a
-- worse answer than starting with the duplicates flagged. The names are printed
-- so they can be resolved, and the index is created on the next run.
DO $$
DECLARE
  clashes TEXT;
BEGIN
  SELECT string_agg(DISTINCT lower(username), ', ')
    INTO clashes
    FROM users
   GROUP BY lower(username)
  HAVING COUNT(*) > 1;

  IF clashes IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
  ELSE
    RAISE WARNING 'Usernames differing only by case: %. Rename or remove one of each pair, then re-run the migration to enforce it.', clashes;
  END IF;
END $$;

-- One upload of the two monthly reports, either of which may be uploaded on
-- its own -- see the check constraint below.
CREATE TABLE IF NOT EXISTS upload_batches (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Nullable on both: a GRN report on its own reconciles as every row PENDING
  -- (nothing to match against yet), and an ageing report on its own has
  -- nothing to reconcile but is still stored for the month -- uploading the
  -- GRN report later is what reconciles it. Null here is "not uploaded", not
  -- "uploaded and empty".
  grn_file_name     TEXT,
  ageing_file_name  TEXT,
  grn_row_count     INTEGER NOT NULL DEFAULT 0,
  ageing_row_count  INTEGER NOT NULL DEFAULT 0,
  uploaded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status            TEXT NOT NULL DEFAULT 'COMPLETED'
);

-- Both reports are now optional; a table created before this change still
-- carries the old NOT NULLs.
ALTER TABLE upload_batches ALTER COLUMN grn_file_name DROP NOT NULL;
ALTER TABLE upload_batches ALTER COLUMN ageing_file_name DROP NOT NULL;

-- An upload naming neither file is not a batch of anything -- the API already
-- refuses it, and this is the same rule enforced at the table itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'upload_batches_has_a_file'
  ) THEN
    ALTER TABLE upload_batches ADD CONSTRAINT upload_batches_has_a_file
      CHECK (grn_file_name IS NOT NULL OR ageing_file_name IS NOT NULL);
  END IF;
END $$;

-- Rows from "01. GRN Report" as uploaded, plus derived comparison keys.
CREATE TABLE IF NOT EXISTS grn_transactions (
  id               SERIAL PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  source_row_no    INTEGER,
  sl_no            INTEGER,
  warehouse        TEXT,
  dpr_no           TEXT NOT NULL,
  dpr_no_key       TEXT NOT NULL,
  po_no            TEXT,
  dpr_date         DATE,
  bill_date        DATE,
  bill_no          TEXT,
  bill_no_key      TEXT,
  dc_no            TEXT,
  vendor_code      TEXT,
  vendor_name      TEXT,
  vendor_name_key  TEXT,
  bill_amount      NUMERIC(18, 4),
  transport_amount NUMERIC(18, 4),
  total_amount     NUMERIC(18, 4),
  location         TEXT,
  add_amount       NUMERIC(18, 4),
  ded_amount       NUMERIC(18, 4)
);

CREATE INDEX IF NOT EXISTS idx_grn_batch_key ON grn_transactions (batch_id, dpr_no_key);

-- An upload replaces a GRN's stored row by its number, and pairs a new ageing
-- report with the GRNs already on file the same way (services/ingest.js), so
-- lookups go by dpr_no_key alone, across every batch -- the other way round
-- from the index above. One row per number since uploads started replacing --
-- see idx_grn_one_per_key in the one-copy-per-GRN block further down.
CREATE INDEX IF NOT EXISTS idx_grn_dpr_no_key ON grn_transactions (dpr_no_key, batch_id DESC);

-- Rows from "02. Vendor ageing report", plus the branch code split out of GRN_NO.
CREATE TABLE IF NOT EXISTS vendor_ageing (
  id                   SERIAL PRIMARY KEY,
  batch_id             INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  source_row_no        INTEGER,
  division             TEXT,
  division_code        TEXT,
  store_name           TEXT,
  vendor_name          TEXT,
  vendor_name_key      TEXT,
  vendor_code          TEXT,
  grn_doc              TEXT,
  grn_no               TEXT,
  branch_code          TEXT,
  grn_number           TEXT,
  grn_number_key       TEXT,
  bill_no              TEXT,
  bill_no_key          TEXT,
  bill_date            DATE,
  net_amt              NUMERIC(18, 4),
  adj_pur_return       NUMERIC(18, 4),
  adjusted_jv          NUMERIC(18, 4),
  tds_jv               NUMERIC(18, 4),
  payable_amount       NUMERIC(18, 4),
  -- The seven checkpoints a bill passes through, in process order. The gaps
  -- between them are the turnaround report.
  indent_date          DATE,
  po_date              DATE,
  security_date        DATE,
  grn_date             DATE,
  bill_to_audit        DATE,
  bill_handover_to_acc DATE,
  chq_date             DATE,
  cheque_clearance_date DATE,
  payment_doc_no       TEXT,
  -- The cheque the bill was paid by. Sits between PaymentDocNo and ChqDate on
  -- the source sheet; text, not a number, because it is an identifier -- a
  -- leading zero on it is part of the cheque, not a rounding artefact.
  cheque_no            TEXT,
  balance              NUMERIC(18, 4)
);

CREATE INDEX IF NOT EXISTS idx_ageing_batch_key ON vendor_ageing (batch_id, grn_number_key);

-- Same reasoning as idx_grn_dpr_no_key above: a GRN's ageing rows are
-- replaced, and found for pairing, by GRN number.
CREATE INDEX IF NOT EXISTS idx_ageing_grn_number_key ON vendor_ageing (grn_number_key, batch_id DESC);

-- ---------------------------------------------------------------------------
-- Migrations for databases created before the turnaround report existed.
--
-- CREATE TABLE IF NOT EXISTS above is a no-op on an existing table -- it will
-- NOT add a column -- so anything added to that block after the first `migrate`
-- run has to be repeated here as an ALTER. Both forms below are idempotent, and
-- this whole file is executed on every `npm run migrate`.
-- ---------------------------------------------------------------------------

-- Uploads used to be labelled by period ("Apr'26"); they are now named freely
-- by the person uploading. Rename in place so existing labels survive as names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'upload_batches' AND column_name = 'period_label'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'upload_batches' AND column_name = 'name'
  ) THEN
    ALTER TABLE upload_batches RENAME COLUMN period_label TO name;
  END IF;
END $$;

ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS indent_date           DATE;
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS po_date               DATE;
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS security_date         DATE;
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS chq_date              DATE;
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS cheque_no             TEXT;

-- A hand-corrected cheque clearance date, which wins over the one derived from
-- the bank statement. Separate from cheque_clearance_date above -- that is the
-- ageing report's own column, which is deliberately never displayed -- so this
-- one is null until somebody actually types a correction, and clearing it
-- hands the answer back to the statement.
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS cheque_clearance_override DATE;
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS cheque_clearance_date DATE;

-- The adjustments between NetAmt and PayableAmount, added for the Valid GRNs view.
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS adj_pur_return        NUMERIC(18, 4);
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS adjusted_jv           NUMERIC(18, 4);
ALTER TABLE vendor_ageing ADD COLUMN IF NOT EXISTS tds_jv                NUMERIC(18, 4);

-- bill_to_audit and bill_handover_to_acc were TEXT holding dd-MM-yyyy, which
-- displays correctly but cannot be subtracted. Convert in place, guarded on the
-- current type so a re-run does nothing (to_date() on a DATE would error).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vendor_ageing'
      AND column_name = 'bill_to_audit'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE vendor_ageing
      ALTER COLUMN bill_to_audit
        TYPE DATE USING to_date(NULLIF(btrim(bill_to_audit), ''), 'DD-MM-YYYY'),
      ALTER COLUMN bill_handover_to_acc
        TYPE DATE USING to_date(NULLIF(btrim(bill_handover_to_acc), ''), 'DD-MM-YYYY');
  END IF;
END $$;

-- One row per GRN transaction: did it reach accounts, and did the details agree.
CREATE TABLE IF NOT EXISTS reconciliation_results (
  id                 SERIAL PRIMARY KEY,
  batch_id           INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  grn_transaction_id INTEGER NOT NULL REFERENCES grn_transactions(id) ON DELETE CASCADE,
  matched_ageing_id  INTEGER REFERENCES vendor_ageing(id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('MATCHED', 'MATCHED_WITH_DIFF', 'PENDING')),
  bill_no_match      BOOLEAN,
  vendor_name_match  BOOLEAN,
  discrepancy_notes  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_results_batch_status ON reconciliation_results (batch_id, status);
-- The lookup by GRN row is the unique idx_results_one_per_grn, created by the
-- one-copy-per-GRN block further down once the duplicates are gone.

-- Replacing a GRN's ageing rows deletes them, and each delete has to find the
-- results pointing at the row to clear their link (ON DELETE SET NULL). Without
-- this that is a scan of every result per ageing row deleted.
CREATE INDEX IF NOT EXISTS idx_results_ageing ON reconciliation_results (matched_ageing_id);

-- --------------------------------------------------------------------------
-- One handover to CSD: a GRN taken off the Valid GRNs tab and passed on.
--
-- The details are copied in rather than joined to. A dispatch records what was
-- sent and when, and it has to outlive the upload it was read from: uploads are
-- deleted, and next month's report carries the same GRN again with its figures
-- moved on. A join would either vanish with the batch or quietly start
-- reporting a different month's numbers against the same handover.
--
-- Keyed on dpr_no_key, uniquely: the same GRN cannot be queued twice, and that
-- uniqueness is what lets the results query left-join this table without
-- multiplying its rows.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS csd_dispatches (
  id                SERIAL PRIMARY KEY,
  dpr_no_key        TEXT NOT NULL UNIQUE,
  dpr_no            TEXT NOT NULL,
  division_code     TEXT,
  dpr_date          DATE,
  bill_no           TEXT,
  bill_date         DATE,
  vendor_code       TEXT,
  vendor_name       TEXT,
  ageing_grn_no     TEXT,
  net_amt           NUMERIC(18, 4),
  payable_amount    NUMERIC(18, 4),
  status            TEXT,
  discrepancy_notes TEXT,
  -- Where the handover has got to at CSD's end. Distinct from `status` above,
  -- which is the reconciliation's verdict on the GRN and does not change once
  -- it is sent; this is CSD's own progress through it.
  stage             TEXT NOT NULL DEFAULT 'QUEUED'
                      CHECK (stage IN ('QUEUED', 'RECEIVED', 'APPROVED', 'REJECTED', 'MOVED_TO_ACCOUNTS')),
  stage_at          TIMESTAMPTZ,
  stage_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- One stamp per stage, not just the latest. `stage_at` says when the row last
  -- moved, which is all the queue screen needs; the turnaround report has to
  -- measure sent-to-received and received-to-approved separately, and a single
  -- column would have been overwritten by the second move.
  received_at       TIMESTAMPTZ,
  approved_at       TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  -- Which upload it was read from. SET NULL rather than CASCADE: deleting the
  -- upload must not delete the record that the GRN went to CSD.
  batch_id          INTEGER REFERENCES upload_batches(id) ON DELETE SET NULL,
  sent_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_csd_sent_at ON csd_dispatches (sent_at DESC);

-- The three stage columns for a table created before they existed. A dispatch
-- that predates them has only ever been queued, which is what the default says.
--
-- These run before the index below them: CREATE TABLE above is a no-op on an
-- existing table, so on that path the column arrives here and nowhere else, and
-- an index declared over it any earlier has nothing to index.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS stage    TEXT NOT NULL DEFAULT 'QUEUED';
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS stage_at TIMESTAMPTZ;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS stage_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- The GRN report's Location, carried into the handover's own snapshot like
-- every other field on this table: the dispatch has to still read correctly
-- once the upload it was taken from has been deleted, so it cannot be joined
-- back to grn_transactions for it. Null on every dispatch made before this
-- column existed -- there is nothing to backfill it from once the batch is gone.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS location TEXT;

-- The rest of the ageing report's own amount breakdown, and the cheque it was
-- paid by, snapshotted alongside NetAmt and PayableAmount for the same reason
-- as everything else on this table -- the queue has to still read correctly
-- once the upload it came from is gone. Null on a dispatch made before these
-- columns existed.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS adj_pur_return NUMERIC(18, 4);
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS adjusted_jv    NUMERIC(18, 4);
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS tds_jv         NUMERIC(18, 4);
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS cheque_no      TEXT;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS payment_doc_no TEXT;
-- The day the ageing report says the cheque was cut -- not the day it cleared,
-- which is read off the bank statement rather than snapshotted here.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS chq_date       DATE;

-- Handing a GRN back to Accounts, once CSD is done with it. MOVED_TO_ACCOUNTS
-- joins APPROVED and REJECTED as a third resolution CSD can reach from
-- RECEIVED, so it still counts as a CSD stage and stays visible on that
-- screen -- but unlike the other two, Accounts then has its own small
-- acknowledgement to make, which is what accounts_stage tracks: QUEUED the
-- moment CSD hands it back, RECEIVED once Accounts has picked it up.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS moved_to_accounts_at TIMESTAMPTZ;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS accounts_stage       TEXT
                                                       CHECK (accounts_stage IN ('QUEUED', 'RECEIVED'));
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS accounts_received_at TIMESTAMPTZ;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS accounts_received_by INTEGER
                                                       REFERENCES users(id) ON DELETE SET NULL;

-- Where Accounts sends a GRN on to, once they have received it back from CSD.
-- The last step in its journey -- there is nothing further to acknowledge, so
-- one set of columns is enough rather than another stage ladder. Name, mobile
-- and date apply to VENDOR and OTHERS alike, since both hand the GRN to a
-- person; Bank does not, and is recorded with nothing more than the fact and
-- the day, which is why those three stay nullable rather than forming their
-- own NOT NULL columns. Courier hands it to a service rather than a person, so
-- it carries its own two columns below in place of name/mobile -- but still
-- uses this same date column, same as VENDOR and OTHERS.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_to TEXT
                                                       CHECK (forwarded_to IN ('BANK', 'VENDOR', 'OTHERS', 'COURIER'));
-- Which of the two doors a VENDOR hand-off went out of -- the vendor directly,
-- or the purchase department that deals with the vendor on the branch's
-- behalf. Meaningless, and left null, for BANK and OTHERS.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_route TEXT
                                                       CHECK (forwarded_route IN ('VENDOR', 'PURCHASE_DEPT'));
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_name   TEXT;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_mobile TEXT;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_date   DATE;
-- OTHERS' own note: there is no vendor record and no purchase-department door
-- behind an arbitrary destination, so a free-text remark is what explains it.
-- Null for every other destination.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_remarks TEXT;
-- COURIER's own pair, in place of name/mobile: which courier it was handed to
-- and the docket number it went out under. Null for every other destination.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_courier_name TEXT;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_docket_no    TEXT;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_at     TIMESTAMPTZ;

-- Why CSD rejected the bill, in their own words. Required by the endpoint when
-- a handover is moved to REJECTED and never written for any other stage, so a
-- filled value is always the reason for the rejection beside it.
--
-- Nullable rather than NOT NULL: every row that is not rejected has nothing to
-- say here, and rejections recorded before this column existed have no reason
-- to backfill from. The rule that a new rejection must carry one lives in the
-- stage endpoint, which is the only thing that writes it.
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS reject_remarks TEXT;

-- Rejections that a later upload reopened.
--
-- A GRN CSD has rejected goes back to the branch to be put right. When it comes
-- round again in a new report it is a fresh bill as far as this system is
-- concerned: the dispatch is removed, so the results screen shows it unsent
-- with its Send picker back, and it can go to CSD again. See
-- reopenRejectedFor in services/ingest.js.
--
-- The dispatch cannot simply be deleted, though. dpr_no_key is UNIQUE on
-- csd_dispatches -- one live handover per GRN, which is what lets every screen
-- join to it without duplicating rows -- so the old rejection has nowhere to
-- sit alongside the new one, and dropping it would take the reason CSD gave
-- with it. That reason is the whole point of a rejection. So it is moved here
-- first: the queue keeps one row per GRN, and why it was turned down the last
-- time is still on file.
--
-- No unique key. The same GRN can be rejected and reopened as many times as it
-- takes, and each of those is its own record.
CREATE TABLE IF NOT EXISTS csd_rejection_history (
  id                     SERIAL PRIMARY KEY,
  dpr_no_key             TEXT NOT NULL,
  dpr_no                 TEXT NOT NULL,
  division_code          TEXT,
  location               TEXT,
  bill_no                TEXT,
  vendor_code            TEXT,
  vendor_name            TEXT,
  cheque_no              TEXT,
  payable_amount         NUMERIC(18, 4),
  -- Why CSD turned it down, and when. The two together are what this table
  -- exists to keep.
  reject_remarks         TEXT,
  rejected_at            TIMESTAMPTZ,
  -- REJECTED is terminal on the CSD ladder, so whoever last moved the stage is
  -- whoever rejected it.
  rejected_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at                TIMESTAMPTZ,
  sent_by                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- The upload that brought the GRN round again. SET NULL rather than CASCADE,
  -- for the same reason csd_dispatches.batch_id is: deleting the upload must
  -- not delete the record of what happened.
  superseded_by_batch_id INTEGER REFERENCES upload_batches(id) ON DELETE SET NULL,
  superseded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_csd_rejection_history_key
  ON csd_rejection_history (dpr_no_key);
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS forwarded_by     INTEGER
                                                       REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE csd_dispatches ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

-- A dispatch that reached a stage before these columns existed has the stamp
-- only in stage_at. Backfill it into the column for the stage it is actually
-- in, so the turnaround report is not blank for rows that predate this.
UPDATE csd_dispatches SET received_at = stage_at WHERE stage = 'RECEIVED' AND received_at IS NULL AND stage_at IS NOT NULL;
UPDATE csd_dispatches SET approved_at = stage_at WHERE stage = 'APPROVED' AND approved_at IS NULL AND stage_at IS NOT NULL;
UPDATE csd_dispatches SET rejected_at = stage_at WHERE stage = 'REJECTED' AND rejected_at IS NULL AND stage_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_csd_stage ON csd_dispatches (stage);

-- Named explicitly so this matches whichever way the constraint arrived: an
-- inline CHECK in the CREATE TABLE above is auto-named the same thing. Dropped
-- and re-added rather than guarded on existing, so a value added to the list
-- later (MOVED_TO_ACCOUNTS) reaches a database that already has this
-- constraint from before that value existed.
ALTER TABLE csd_dispatches DROP CONSTRAINT IF EXISTS csd_dispatches_stage_check;
ALTER TABLE csd_dispatches ADD CONSTRAINT csd_dispatches_stage_check
  CHECK (stage IN ('QUEUED', 'RECEIVED', 'APPROVED', 'REJECTED', 'MOVED_TO_ACCOUNTS'));

-- Same reasoning as csd_dispatches_stage_check above: a database that already
-- has forwarded_to from before COURIER existed still has the narrower check,
-- which ADD COLUMN IF NOT EXISTS never revisits.
ALTER TABLE csd_dispatches DROP CONSTRAINT IF EXISTS csd_dispatches_forwarded_to_check;
ALTER TABLE csd_dispatches ADD CONSTRAINT csd_dispatches_forwarded_to_check
  CHECK (forwarded_to IN ('BANK', 'VENDOR', 'OTHERS', 'COURIER'));

-- --------------------------------------------------------------------------
-- The bank statement's transaction table (file 06), and nothing else from it.
--
-- The sheet around this is a letterhead -- address block, account details, a
-- statement summary, a page of small print -- and none of it is data. Only the
-- rows between the two rules are stored.
--
-- extracted_cheque_no is the last six digits of chq_ref_no, computed at parse
-- time rather than derived on read: it is what the statement is matched to the
-- ageing report by, and an index on a stored column is worth more than the few
-- bytes it costs. The statement pads a cheque out to fifteen or sixteen
-- characters ("0000000000066893"), the ageing report writes six ("066893").
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_statement_transactions (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  source_row_no       INTEGER,
  txn_date            DATE,
  narration           TEXT,
  chq_ref_no          TEXT,
  extracted_cheque_no TEXT,
  value_date          DATE,
  withdrawal_amt      NUMERIC(18, 4),
  deposit_amt         NUMERIC(18, 4),
  closing_balance     NUMERIC(18, 4)
);

CREATE INDEX IF NOT EXISTS idx_bank_batch ON bank_statement_transactions (batch_id);
CREATE INDEX IF NOT EXISTS idx_bank_cheque ON bank_statement_transactions (extracted_cheque_no);

-- The statement is optional, so a batch uploaded without one keeps a null file
-- name and a zero count rather than being a different kind of batch.
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS bank_file_name TEXT;
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS bank_row_count INTEGER NOT NULL DEFAULT 0;
-- The account the statement was for, read out of its letterhead. Null on an
-- upload made before this column existed, and on a statement whose letterhead
-- does not carry one -- neither is an error, the transactions still reconcile.
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS bank_account_no TEXT;

-- upload_batches_has_a_file predates the bank statement column above and so
-- named only the other two -- a batch naming just a statement was refused by
-- this same rule, even though it is stored and useful entirely on its own
-- (see routes/batches.js). It has to be widened to allow one.
--
-- Widened where the BPAD columns are added further down, and deliberately not
-- here as well. This block used to drop and re-add the constraint naming three
-- files, and that made this file order-dependent in a way that eventually bit:
-- once a BPAD-only batch existed, replaying the schema re-added the
-- three-file rule BEFORE reaching the four-file one below it, and the
-- three-file ADD was rejected by the very row the four-file rule exists to
-- allow -- taking the whole migration down with it, on a database whose data
-- was perfectly valid.
--
-- So the constraint is defined in exactly one place, and it is the last word
-- on the subject: see the DROP/ADD pair beside bpad_file_name. Adding a fifth
-- optional file means editing that one, and nothing here.

-- --------------------------------------------------------------------------
-- The BPAD register (Bills Pending at Accounts Department), narrowed to this
-- installation's own GRNs.
--
-- The source workbook is the whole group's register -- 327,000 rows and fifty
-- megabytes of it -- and all but a few thousand of those rows are about GRNs
-- this upload is not about. Storing it whole would be storing somebody else's
-- report, so only the matching rows are kept: the match is on the vendor code
-- AND the GRN number together, against the GRN report uploaded beside it (or
-- against every GRN on file when none was), both halves folded through the
-- same normKey the reconciliation matches with. The filtering happens while
-- the sheet is being read -- see readBpadReport and grnMatchKeys -- so the
-- rows that are not kept are never built in the first place.
--
-- Not joined to grn_transactions by a foreign key, and deliberately. A BPAD
-- upload is a snapshot of where a bill had got to on the day it was taken, and
-- it has to still read correctly once the upload it was matched against has
-- been deleted -- the same reasoning csd_dispatches is written under. The two
-- keys are carried instead, which is what the results screen re-joins on.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bpad_records (
  id                     SERIAL PRIMARY KEY,
  batch_id               INTEGER NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  source_row_no          INTEGER,
  sl_no                  INTEGER,
  location               TEXT,
  warehouse              TEXT,
  vendor_code            TEXT,
  -- The two halves of the match, normalised. Stored rather than derived on
  -- read for the same reason bank_statement_transactions stores
  -- extracted_cheque_no: it is what the row is looked up by, and an index over
  -- a stored column is worth the few bytes it costs.
  vendor_code_key        TEXT,
  vendor_name            TEXT,
  inv_no                 TEXT,
  inv_date               DATE,
  grn_no                 TEXT,
  grn_no_key             TEXT,
  grn_date               DATE,
  grn_amount             NUMERIC(18, 4),
  po_number              TEXT,
  po_date                DATE,
  pending_with_dept      TEXT,
  -- The two dates the register exists to report: when BPAD took the bill in,
  -- and when Accounts did. Empty on a bill that has not got that far, which is
  -- the answer rather than missing data.
  bpad_received_date     DATE,
  accounts_received_date DATE,
  pending_with_user      TEXT,
  pend_reason            TEXT
);

-- The register's own three ageing counts -- QueryAgeing, Ageing and GRN Age --
-- used to be stored here and shown on the tab. They are gone: the register
-- recomputes all three from its own dates every time it is exported, so a
-- stored copy was only ever as true as the day the file was uploaded, and the
-- two dates it derives them from (bpad_received_date, accounts_received_date)
-- are kept above.
--
-- DROP rather than left in place, so an installation that has already stored
-- them stops carrying figures nothing reads. Same idiom as the ADD below: the
-- whole file is re-run on every migrate, so it has to be safe to apply twice.
ALTER TABLE bpad_records DROP COLUMN IF EXISTS query_ageing;
ALTER TABLE bpad_records DROP COLUMN IF EXISTS ageing;
ALTER TABLE bpad_records DROP COLUMN IF EXISTS grn_age;

-- The register's Vendor Category went the same way: it is no longer read,
-- shown or exported, so an installation that stored it stops carrying it.
ALTER TABLE bpad_records DROP COLUMN IF EXISTS vendor_category;

-- Whether the register actually had an entry for this GRN.
--
-- A BPAD upload stores a row for every GRN it is about, not only the ones the
-- register knew -- so a GRN with no entry is stored here too, carrying the
-- identity the GRN report has for it (vendor, GRN number and date, PO, invoice,
-- amount -- the facts both files spell the same way) and nothing else. The
-- register's own columns stay null on it, which is the truth: BPAD has not been
-- told about this bill.
--
-- In practice those are the GRNs received on a delivery challan with no vendor
-- invoice raised yet -- the GRN report writes "-" in Bill No for them -- and
-- BPAD is a register of BILLS pending, so a GRN with no bill has nothing to be
-- pending. They are not in BPAD, so the BPAD tab and its export leave these
-- rows out (BPAD_IN_REGISTER in routes/results.js); they are the GRNs still at
-- the GRN store, which the Pending GRNs at GRN Store card counts and lists.
-- See bpadRowsForGrns in routes/batches.js for why they are stored at all.
--
-- DEFAULT TRUE so rows stored before this column existed read as what they
-- were: register rows, every one of them.
ALTER TABLE bpad_records ADD COLUMN IF NOT EXISTS in_register BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_bpad_batch ON bpad_records (batch_id);

-- The results screen reads this by GRN number -- see the BPAD tab in
-- routes/results.js -- and the upload deletes by it, which is the heavier of
-- the two: every upload with a register clears a few thousand GRNs before it
-- inserts their replacements. Same shape as idx_grn_dpr_no_key.
CREATE INDEX IF NOT EXISTS idx_bpad_grn_no_key ON bpad_records (grn_no_key, batch_id DESC);

-- --------------------------------------------------------------------------
-- One generation per GRN, not one per upload.
--
-- The register is re-exported and re-uploaded as bills move -- the same
-- workbook, corrected, several times in a day -- and every upload used to
-- leave its own copy of every row it matched behind. Six uploads of one
-- register put 23,814 rows in a table describing 3,402 GRNs, and only the
-- newest copy of each was ever read: the tab folded the rest away on every
-- query and nothing else ever asked for them.
--
-- So an upload now clears a GRN's previous rows before inserting its new ones
-- -- see clearBpadRecordsFor in services/ingest.js -- and this clears out what
-- the old behaviour left behind.
--
-- Older generations only: the newest batch to mention a GRN keeps ALL of its
-- rows for it, because the register repeats a GRN across a split invoice and
-- those repeats are the file as it arrived rather than duplicates. Which is
-- also why this cannot be a unique constraint instead.
--
-- Scoped per GRN rather than per batch, so an upload that covered a different
-- month's GRNs keeps them -- what goes is a GRN's stale rows, never a batch's
-- only ones.
--
-- Idempotent, which it has to be: this file is re-run on every migrate. Once
-- no GRN has rows from two batches it deletes nothing.
-- --------------------------------------------------------------------------
DELETE FROM bpad_records b
WHERE b.batch_id < (
  SELECT MAX(b2.batch_id)
  FROM bpad_records b2
  WHERE b2.vendor_code_key IS NOT DISTINCT FROM b.vendor_code_key
    AND b2.grn_no_key      IS NOT DISTINCT FROM b.grn_no_key
);

-- --------------------------------------------------------------------------
-- One copy per GRN in the other tables too.
--
-- Uploads used to add rows beside the ones already stored, and the screens
-- read only the newest copy of each GRN -- so the GRN report uploaded twice
-- left 8,965 GRN rows and results describing 5,563 GRNs. An upload now
-- replaces what is stored for the GRNs and transactions it carries (saveBatch
-- in services/ingest.js), and this clears away what the old behaviour left:
--
--   GRN rows      the newest copy of each GRN number is kept;
--   results       the newest for each GRN row is kept -- the one the screens
--                 already showed;
--   ageing rows   for each GRN number, the rows of the newest upload that
--                 carried it -- all of them, one per cheque -- are kept, and a
--                 hand-typed cheque clearance date on an older row moves to the
--                 kept row for the same cheque;
--   bank rows     a transaction a newer statement also carries is kept only as
--                 that statement's copy.
--
-- Rows only, never an upload: an upload's other files stay whatever happens to
-- its GRN report's rows -- one upload can hold the only copy of an ageing
-- report or a statement.
--
-- A result that pointed at a cleared ageing row loses its link here (ON DELETE
-- SET NULL); `npm run migrate` re-links every result right after this file
-- runs -- see relinkStoredResults in services/ingest.js.
--
-- Idempotent, which it has to be: this file is re-run on every migrate. Once
-- nothing is stored twice, it deletes nothing.
-- --------------------------------------------------------------------------
DELETE FROM grn_transactions g
 USING grn_transactions n
 WHERE n.dpr_no_key = g.dpr_no_key
   AND g.dpr_no_key <> ''
   AND (n.batch_id, n.id) > (g.batch_id, g.id);

DELETE FROM reconciliation_results r
 USING reconciliation_results n
 WHERE n.grn_transaction_id = r.grn_transaction_id
   AND (n.batch_id, n.id) > (r.batch_id, r.id);

WITH newest AS (
  SELECT grn_number_key, MAX(batch_id) AS batch_id
    FROM vendor_ageing
   WHERE grn_number_key <> ''
   GROUP BY grn_number_key
), carried AS (
  SELECT DISTINCT ON (o.grn_number_key, o.cheque_no)
         o.grn_number_key, o.cheque_no, o.cheque_clearance_override
    FROM vendor_ageing o
    JOIN newest w ON w.grn_number_key = o.grn_number_key
   WHERE o.batch_id < w.batch_id
     AND o.cheque_clearance_override IS NOT NULL
     AND COALESCE(o.cheque_no, '') <> ''
   ORDER BY o.grn_number_key, o.cheque_no, o.batch_id DESC, o.id DESC
)
UPDATE vendor_ageing n
   SET cheque_clearance_override = c.cheque_clearance_override
  FROM newest w, carried c
 WHERE n.grn_number_key = w.grn_number_key
   AND n.batch_id = w.batch_id
   AND n.cheque_clearance_override IS NULL
   AND c.grn_number_key = n.grn_number_key
   AND c.cheque_no = n.cheque_no;

DELETE FROM vendor_ageing o
 USING (
   SELECT grn_number_key, MAX(batch_id) AS batch_id
     FROM vendor_ageing
    WHERE grn_number_key <> ''
    GROUP BY grn_number_key
 ) w
 WHERE o.grn_number_key = w.grn_number_key
   AND o.batch_id < w.batch_id;

-- The same test clearEarlierBankRows in services/ingest.js applies to a new
-- statement: every column of the row, and the account where both uploads name
-- one. The newer statement's copy stays, including a row it carries twice.
DELETE FROM bank_statement_transactions o
 USING bank_statement_transactions n, upload_batches ob, upload_batches nb
 WHERE n.batch_id > o.batch_id
   AND ob.id = o.batch_id
   AND nb.id = n.batch_id
   AND (ob.bank_account_no IS NULL OR nb.bank_account_no IS NULL OR ob.bank_account_no = nb.bank_account_no)
   AND o.txn_date = n.txn_date
   AND COALESCE(o.chq_ref_no, '') = COALESCE(n.chq_ref_no, '')
   AND COALESCE(o.narration, '')  = COALESCE(n.narration, '')
   AND o.value_date      IS NOT DISTINCT FROM n.value_date
   AND o.withdrawal_amt  IS NOT DISTINCT FROM n.withdrawal_amt
   AND o.deposit_amt     IS NOT DISTINCT FROM n.deposit_amt
   AND o.closing_balance IS NOT DISTINCT FROM n.closing_balance;

-- And the rule held from here on. A GRN number that folds to nothing ('') is
-- left out: there is no telling two of those apart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_grn_one_per_key
  ON grn_transactions (dpr_no_key) WHERE dpr_no_key <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_one_per_grn
  ON reconciliation_results (grn_transaction_id);
-- The plain index this replaces.
DROP INDEX IF EXISTS idx_results_grn;

-- The BPAD register is optional, so a batch uploaded without one keeps a null
-- file name and a zero count rather than being a different kind of batch.
-- bpad_matched_count is what was kept; bpad_row_count is what was read, and
-- the pair is what lets the upload say "3,468 of 327,292" rather than leaving
-- a reader to wonder where the rest went.
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS bpad_file_name     TEXT;
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS bpad_row_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS bpad_matched_count INTEGER NOT NULL DEFAULT 0;

-- upload_batches_has_a_file predates this column too, the same way it predated
-- the bank statement's -- and unlike a statement, a BPAD register uploaded on
-- its own is a perfectly ordinary thing to do: it is matched against every GRN
-- already on file, not only against one uploaded beside it. Dropped and
-- re-added for the reason given above the last time it was widened.
ALTER TABLE upload_batches DROP CONSTRAINT IF EXISTS upload_batches_has_a_file;
ALTER TABLE upload_batches ADD CONSTRAINT upload_batches_has_a_file
  CHECK (grn_file_name IS NOT NULL
      OR ageing_file_name IS NOT NULL
      OR bank_file_name IS NOT NULL
      OR bpad_file_name IS NOT NULL);

-- --------------------------------------------------------------------------
-- Handed to Records.
--
-- The other destination a Valid GRN can be sent to, beside CSD. Deliberately
-- thin: Records has no queue screen and no stages, so nothing here is read back
-- except the fact that it went. That is why there is no snapshot of the GRN --
-- unlike csd_dispatches, which has to still describe a handover after its
-- upload is gone, this is only ever shown beside the results row it belongs to,
-- and that row carries its own details.
--
-- Keyed on dpr_no_key, uniquely, and on the same normKey the reconciliation
-- matches with -- so sending the same GRN twice, or sending it again from a
-- newer upload, refreshes the record rather than adding a second one.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_dispatches (
  id         SERIAL PRIMARY KEY,
  dpr_no_key TEXT NOT NULL UNIQUE,
  dpr_no     TEXT NOT NULL,
  -- Which upload it was read from. SET NULL rather than CASCADE: deleting the
  -- upload must not delete the record that the GRN went to Records.
  batch_id   INTEGER REFERENCES upload_batches(id) ON DELETE SET NULL,
  sent_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_sent_at ON record_dispatches (sent_at DESC);

-- --------------------------------------------------------------------------
-- Branches, as configured.
--
-- One row per branch, naming the things that identify it in the files this
-- system reads:
--
--   branch_code    the ageing report's DivisionCode           ("SE1")
--   location       a fragment of the GRN report's Location    ("SECUNDERABAD")
--   account_no     the account its bank statement is for      ("59219911199911")
--   bpad_location  the BPAD register's Location               ("SBD")
--
-- `is_selected` is the tick box on the configuration screen, and it scopes what
-- the results and CSD screens show. It is installation-wide, not per user: a
-- branch is either in scope for this installation or it is not, and two people
-- looking at the same figures should be looking at the same rows. With nothing
-- ticked, nothing is narrowed -- every row is shown, which is what the screens
-- did before any of this existed.
--
-- The tick box filters no upload. Every row of every file is still stored and
-- reconciled; it only decides what is displayed, so a branch can be ticked and
-- unticked without re-uploading anything. bpad_location is the one field that
-- does act on an upload -- see below.
--
-- The unique index is on the branch code folded to upper case, because that is
-- how DivisionCode is matched -- "se1" and "SE1" are one branch, and letting
-- both exist would double every row they select.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branch_configs (
  id          SERIAL PRIMARY KEY,
  branch_code TEXT NOT NULL,
  location    TEXT NOT NULL,
  account_no  TEXT,
  is_selected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_code ON branch_configs (upper(branch_code));
CREATE INDEX IF NOT EXISTS idx_branch_selected ON branch_configs (is_selected);

-- What the BPAD register writes in its Location column for this branch ("SBD").
--
-- The register is the whole group's, and the branches number some GRN series
-- independently -- Malakpet has a GFEVT0000013 as well as Secunderabad, raised
-- against the same vendor. Vendor code and GRN number alone therefore let the
-- other branch's bill in beside this one's. Filled in, a register row is kept
-- only when its Location is this, for a GRN whose GRN-report Location names
-- this branch -- see grnMatchKeys in routes/batches.js.
--
-- Optional, and read at upload time only: left blank, the branch's GRNs are
-- matched on vendor code and GRN number as before, and filling it in changes
-- nothing already stored until the register is uploaded again.
ALTER TABLE branch_configs ADD COLUMN IF NOT EXISTS bpad_location TEXT;

-- --------------------------------------------------------------------------
-- activity_logs: who did what, and when -- the Activity logs screen.
--
-- One row per user action that changes something: an upload, a GRN sent to
-- CSD or Records, a CSD stage move, a take-back, Accounts receiving or
-- forwarding a GRN, a date correction, an account or branch edited. Written by
-- services/activityLog.js after the action has succeeded, and never allowed to
-- fail the action it describes.
--
-- The user's name is copied onto the row as well as referenced, so an entry
-- still says who acted after that account has been renamed or deleted.
--
-- Kept for 90 days: purgeOldLogs deletes anything older, at startup and daily.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  user_name   TEXT,
  action      TEXT NOT NULL,
  category    TEXT NOT NULL,
  target      TEXT,
  summary     TEXT NOT NULL,
  details     JSONB,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_category ON activity_logs (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs (user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- The Accounts Depot screen was renamed Accounts Department, and its screen
-- key with it: 'accounts-depot' -> 'accounts-department'. Accounts granted
-- the old key keep their access. Idempotent: once converted, nothing matches.
-- --------------------------------------------------------------------------
UPDATE users
   SET screens = array_replace(screens, 'accounts-depot', 'accounts-department')
 WHERE 'accounts-depot' = ANY(screens);

-- --------------------------------------------------------------------------
-- The Uploaded files screen ('uploads') is gone: the results screens show
-- every GRN once, from its latest upload, so there are no uploads to manage
-- or delete one by one. Its grant is taken off every account, so it cannot
-- linger in the stored list. Idempotent: once removed, nothing matches.
-- --------------------------------------------------------------------------
UPDATE users
   SET screens = array_remove(screens, 'uploads')
 WHERE 'uploads' = ANY(screens);

-- --------------------------------------------------------------------------
-- Changes to stored data that are made once and must not be made again.
--
-- Everything else in this file is safe to repeat because repeating it finds
-- nothing left to do. A change an administrator may afterwards undo by hand is
-- not like that: run again, it would put back what they took away. So each
-- such change claims a name here, in the transaction that makes it, and is
-- skipped wherever the name is already taken.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS one_time_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 'ph-screen-grants': the OP Pharmacy screens were given screen keys of their
-- own -- each hospital key under ph- (SCREENS in config/screens.js). Until then
-- a hospital screen's grant opened its OP Pharmacy twin as well, and the one
-- CS Department grant both queues. So that nobody loses a screen by the split,
-- every account holding a hospital screen is given its twin:
--
--   upload -> ph-upload     results -> ph-results     csd -> ph-csd
--   accounts-department -> ph-accounts-department     config -> ph-config
--
-- Once. From then on the two are separate tick boxes on User management, and
-- an administrator who unticks one must not find it ticked again by the next
-- `npm run migrate`: the INSERT below finds the name taken on every later run
-- and nothing after it happens.
--
-- After the two key changes above, so an account still carrying
-- 'accounts-depot' is given Ph-Accounts through the key it was renamed to.
--
-- Each list is written back in the catalogue's order, which is how the users
-- API stores one (cleanScreens in routes/users.js): the activity log compares
-- the stored lists as they are, and would otherwise report "screens" changed
-- the next time such an account was saved. `catalogue` is SCREENS' keys in
-- SCREENS' order. A key it does not list is kept, after the rest.
--
-- Administrators and deactivated accounts are included: what is stored against
-- them is what they come back to if demoted or reactivated.
--
-- The name is claimed for the database, not for the accounts in it. If `users`
-- is ever restored from a backup taken before this ran, its accounts come back
-- without their twins and nothing here gives them again: delete the name
-- (DELETE FROM one_time_migrations WHERE name = 'ph-screen-grants') and run
-- `npm run migrate` once more.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  catalogue CONSTANT TEXT[] := ARRAY[
    'upload', 'results', 'accounts-department', 'csd', 'config',
    'ph-upload', 'ph-results', 'ph-accounts-department', 'ph-csd', 'ph-config',
    'vendor-master', 'msme-reco', 'users', 'logs'];
  twinned CONSTANT TEXT[] := ARRAY['upload', 'results', 'accounts-department', 'csd', 'config'];
BEGIN
  INSERT INTO one_time_migrations (name) VALUES ('ph-screen-grants')
  ON CONFLICT (name) DO NOTHING;

  IF FOUND THEN
    UPDATE users u
       SET screens = ARRAY(
             SELECT t.k
               FROM unnest(u.screens || ARRAY(
                      SELECT 'ph-' || s.h FROM unnest(u.screens) AS s(h) WHERE s.h = ANY(twinned)
                    )) AS t(k)
              GROUP BY t.k
              ORDER BY array_position(catalogue, t.k) NULLS LAST, t.k
           )
     WHERE u.screens && twinned;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- HIS vs FOCUS Reco (named msme_reco here, which is what it began as): the
-- HIS vendor master held against the Accounts (FOCUS) vendor list.
--
-- One run per upload -- both files, or either alone against the other's
-- latest (msme_reco_files) -- and one row per vendor master row:
-- found in Accounts (MATCHED or MISMATCH) or not (NOT_IN_ACCOUNTS). Accounts
-- codes the vendor master lacks (NOT_IN_HIS) are counted on the run and not
-- stored as rows. The matching itself is services/msmeReco.js; this only keeps
-- its answer, so a run can be reopened without uploading the two files again.
--
-- The compared values are stored cleaned -- trimmed, and a placeholder such as
-- "NA" or "-" stored as NULL -- in his_/acc_ pairs named after the reco's
-- field keys (drugLicence -> his_drug_licence). mismatch_fields lists the keys
-- of the pairs that disagree, which is what the per-field filter reads.
--
-- The counts on the run are the reco's summary at the time it ran, kept for
-- the run selector; the screen's own cards are counted from the rows.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS msme_reco_runs (
  id                    SERIAL PRIMARY KEY,
  vendor_file_name      TEXT NOT NULL,
  vendor_sheet_name     TEXT,
  account_file_name     TEXT NOT NULL,
  vendor_row_count      INTEGER NOT NULL DEFAULT 0,
  account_row_count     INTEGER NOT NULL DEFAULT 0,
  matched_count         INTEGER NOT NULL DEFAULT 0,
  mismatch_count        INTEGER NOT NULL DEFAULT 0,
  not_in_accounts_count INTEGER NOT NULL DEFAULT 0,
  not_in_his_count      INTEGER NOT NULL DEFAULT 0,
  uploaded_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Either file can be uploaded alone: the side left out is the latest one kept
-- in msme_reco_files below. `*_file_new` says whether the run's own upload
-- brought that file (FALSE: the kept one was used), and `*_file_at` when the
-- file it used was uploaded. Runs stored before this brought both, so they
-- read TRUE, and NULL for the time -- the run's own.
ALTER TABLE msme_reco_runs ADD COLUMN IF NOT EXISTS vendor_file_new BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE msme_reco_runs ADD COLUMN IF NOT EXISTS account_file_new BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE msme_reco_runs ADD COLUMN IF NOT EXISTS vendor_file_at TIMESTAMPTZ;
ALTER TABLE msme_reco_runs ADD COLUMN IF NOT EXISTS account_file_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS msme_reco_rows (
  id                   SERIAL PRIMARY KEY,
  run_id               INTEGER NOT NULL REFERENCES msme_reco_runs(id) ON DELETE CASCADE,
  -- The order the reco produced: the vendor master's own order, then the
  -- Accounts list's for the codes only it carries.
  seq                  INTEGER NOT NULL,
  status               TEXT NOT NULL
                         CHECK (status IN ('MATCHED', 'MISMATCH', 'NOT_IN_ACCOUNTS', 'NOT_IN_HIS')),
  vendor_code          TEXT NOT NULL,
  acc_code             TEXT,
  his_row_no           INTEGER,
  acc_row_no           INTEGER,
  warehouse            TEXT,
  his_status           TEXT,
  his_name             TEXT,
  acc_name             TEXT,
  his_pan              TEXT,
  acc_pan              TEXT,
  his_gst              TEXT,
  acc_gst              TEXT,
  his_drug_licence     TEXT,
  acc_drug_licence     TEXT,
  his_msme_no          TEXT,
  acc_msme_no          TEXT,
  his_msme_type        TEXT,
  acc_msme_type        TEXT,
  his_msme_activity    TEXT,
  acc_msme_activity    TEXT,
  his_bank_account_no  TEXT,
  acc_bank_account_no  TEXT,
  his_ifsc             TEXT,
  acc_ifsc             TEXT,
  his_payee_name       TEXT,
  acc_payee_name       TEXT,
  mismatch_fields      TEXT[] NOT NULL DEFAULT '{}',
  remarks              TEXT
);

CREATE INDEX IF NOT EXISTS idx_msme_rows_run_status ON msme_reco_rows (run_id, status, seq);
CREATE INDEX IF NOT EXISTS idx_msme_rows_run_seq ON msme_reco_rows (run_id, seq);
-- The GRN screens' MSME No and MSME Status used to be looked up here, in the
-- latest run, and this index was for that. They read the Vendor Master now
-- (vendor_master.msme_no below), so it goes.
DROP INDEX IF EXISTS idx_msme_rows_run_vendor;

-- Runs stored before the Accounts-only codes stopped being kept still carry a
-- row for each -- about 29,000 per run. The count on the run already records
-- them, so the rows go. Idempotent: once cleared, nothing matches.
DELETE FROM msme_reco_rows WHERE status = 'NOT_IN_HIS';

-- The latest file of each side, as the reco reads it -- one row for HIS (the
-- vendor master's reco sheet) and one for FOCUS (the Accounts vendor list),
-- each replaced by the next upload of that side. What lets either file be
-- uploaded alone: the reco holds it against the other side's row here.
-- `rows` is the parser's records (readVendorMaster's `rows`, readAccountMaster's
-- `rows`); only the latest is kept, as the runs keep their own answers.
CREATE TABLE IF NOT EXISTS msme_reco_files (
  side         TEXT PRIMARY KEY CHECK (side IN ('HIS', 'FOCUS')),
  file_name    TEXT NOT NULL,
  sheet_name   TEXT,
  row_count    INTEGER NOT NULL,
  rows         JSONB NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL
);

-- The HIS side, rebuilt from the latest run for a database that ran recos
-- before files were kept, so a FOCUS list can be uploaded alone straight
-- away. Lossless for the reco: it stored every compared HIS value, cleaned as
-- the reco would clean it again. The FOCUS side cannot be rebuilt -- the codes
-- only FOCUS has were never stored -- so it waits for the next FOCUS upload.
-- Idempotent: once there is an HIS row, nothing is inserted.
INSERT INTO msme_reco_files (side, file_name, sheet_name, row_count, rows, uploaded_by, uploaded_at)
SELECT 'HIS', r.vendor_file_name, r.vendor_sheet_name, jsonb_array_length(h.rows), h.rows, r.uploaded_by, r.uploaded_at
  FROM (SELECT * FROM msme_reco_runs ORDER BY uploaded_at DESC, id DESC LIMIT 1) r
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'sourceRowNo', m.his_row_no,
             'vendorCode', m.vendor_code,
             'warehouse', m.warehouse,
             'status', m.his_status,
             'vendorName', m.his_name,
             'panNo', m.his_pan,
             'gstNumber', m.his_gst,
             'drugLicenceNo', m.his_drug_licence,
             'msmeNumber', m.his_msme_no,
             'enterpriseType', m.his_msme_type,
             'enterpriseActivity', m.his_msme_activity,
             'bankAccountNo', m.his_bank_account_no,
             'ifsc', m.his_ifsc,
             'payeeName', m.his_payee_name
           ) ORDER BY m.seq) AS rows
      FROM msme_reco_rows m
     WHERE m.run_id = r.id AND m.status <> 'NOT_IN_HIS'
  ) h
 WHERE h.rows IS NOT NULL
ON CONFLICT (side) DO NOTHING;

-- --------------------------------------------------------------------------
-- Vendor Master: every vendor the HIS vendor master has ever listed, once
-- each, with its latest details.
--
-- The HIS vendor master is the correct data; the reco says what FOCUS
-- (Accounts) needs changing to match it. It has no upload of its own: every
-- HIS vs FOCUS Reco run applies its vendor master file here (see
-- services/vendorMaster.js). A vendor code already here is updated with the
-- file's values; a new one is added. Nothing is ever removed, and the app has
-- no way to delete a reco run, so uploading the same file again only updates
-- what changed.
--
-- `code_key` is what makes a vendor the same vendor from one file to the next:
-- the code trimmed, runs of spaces folded to one and upper-cased, as the reco
-- matches (codeKey in services/msmeReco.js). `data` is the vendor's details
-- keyed by the file's own column names. An update merges the file's row over
-- what is there, so every column the latest file has takes its value from it
-- -- a blank included -- and a column it does not have keeps the last value
-- given.
--
-- The three times are when a file was applied (see applied_at below): when the
-- vendor was first added, when its details last changed, and when a file last
-- carried it. `last_seen_at` is also what stops an older run, applied late,
-- from undoing a newer one.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_master (
  id            SERIAL PRIMARY KEY,
  code_key      TEXT NOT NULL UNIQUE,
  -- As the latest file spells it.
  vendor_code   TEXT NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  last_run_id   INTEGER REFERENCES msme_reco_runs(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  msme_no       TEXT,
  supply_type   TEXT NOT NULL DEFAULT 'REGULAR',
  inter         TEXT NOT NULL DEFAULT 'NO',
  address       TEXT
);

-- The vendor's MSME number, out of `data` (its MSME_NUMBER column), cleaned
-- the way the reco cleans a value -- a placeholder such as "NA" or "-" is NULL,
-- so a filled one is a real number. What the MSME No and MSME Status columns on
-- every GRN screen read (services/vendorMsme.js). Worked out in JavaScript, by
-- the reco's own cleanValue, and so stored rather than derived in SQL: written
-- with `data` on every apply, and filled for vendors stored before it by `npm
-- run migrate` (see services/vendorMaster.js).
ALTER TABLE vendor_master ADD COLUMN IF NOT EXISTS msme_no TEXT;

-- The two details picked by hand on the Vendor Master screen, from a dropdown
-- each (PATCH /api/vendor-master/:id): the vendor's supply type, STENTS or
-- REGULAR, and whether it is Inter, YES or NO. Every vendor starts REGULAR and
-- NO -- the ones here already and every one a reco adds -- until somebody
-- picks otherwise. No HIS file carries either, so applying a file never
-- touches them: a re-upload cannot undo a choice. The checks are dropped and
-- re-added rather than guarded, so a value added to a list later reaches a
-- database that already has the narrower check.
ALTER TABLE vendor_master ADD COLUMN IF NOT EXISTS supply_type TEXT NOT NULL DEFAULT 'REGULAR';
ALTER TABLE vendor_master ADD COLUMN IF NOT EXISTS inter TEXT NOT NULL DEFAULT 'NO';
-- For columns added before they had a default: the vendors left unset read
-- REGULAR and NO too, and a vendor already picked keeps its pick. Idempotent:
-- once none is NULL, nothing matches.
ALTER TABLE vendor_master ALTER COLUMN supply_type SET DEFAULT 'REGULAR';
UPDATE vendor_master SET supply_type = 'REGULAR' WHERE supply_type IS NULL;
ALTER TABLE vendor_master ALTER COLUMN supply_type SET NOT NULL;
ALTER TABLE vendor_master ALTER COLUMN inter SET DEFAULT 'NO';
UPDATE vendor_master SET inter = 'NO' WHERE inter IS NULL;
ALTER TABLE vendor_master ALTER COLUMN inter SET NOT NULL;
ALTER TABLE vendor_master DROP CONSTRAINT IF EXISTS vendor_master_supply_type_check;
ALTER TABLE vendor_master ADD CONSTRAINT vendor_master_supply_type_check
  CHECK (supply_type IN ('STENTS', 'REGULAR'));
ALTER TABLE vendor_master DROP CONSTRAINT IF EXISTS vendor_master_inter_check;
ALTER TABLE vendor_master ADD CONSTRAINT vendor_master_inter_check
  CHECK (inter IN ('YES', 'NO'));

-- The vendor's address as typed on the Vendor Master screen, for printing --
-- NULL until somebody saves one, and the screen offers the HIS file's own
-- ADDRESS until then. Like the two above, applying a file never touches it.
ALTER TABLE vendor_master ADD COLUMN IF NOT EXISTS address TEXT;

-- The master's columns, in the order the screen and the export show them: the
-- latest file's own order, then any column only an earlier file had.
CREATE TABLE IF NOT EXISTS vendor_master_columns (
  name      TEXT PRIMARY KEY,
  position  INTEGER NOT NULL
);

-- One row per file applied to the master: which reco brought it, the sheet
-- read, and how many vendors it added, updated, left unchanged, or skipped
-- because a newer file had already carried them -- for the screens' "last
-- updated" lines. Kept apart from msme_reco_runs, and run_id set to NULL rather
-- than the row removed if a run is ever deleted in the database by hand: the
-- master outlives its runs, and should still say where its details came from.
--
-- A run with no row here has not been applied yet -- one stored before the
-- master existed, or by a server still running older code. applyPendingRuns
-- (services/vendorMaster.js) applies those, oldest first: from migrate.js, at
-- server start, and before each new reco. `full_file` is FALSE for them,
-- since their files were not kept and only the columns the reco reads could
-- be rebuilt.
--
-- `applied_at` is the time the master records for the file. For a new reco it
-- is read under the master's lock, so files are ordered as they were applied;
-- for a late one it is the run's own uploaded_at.
CREATE TABLE IF NOT EXISTS vendor_master_applies (
  id               SERIAL PRIMARY KEY,
  run_id           INTEGER UNIQUE REFERENCES msme_reco_runs(id) ON DELETE SET NULL,
  file_name        TEXT,
  sheet_name       TEXT,
  run_uploaded_at  TIMESTAMPTZ NOT NULL,
  uploaded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applied_at       TIMESTAMPTZ NOT NULL,
  added            INTEGER NOT NULL,
  updated          INTEGER NOT NULL,
  unchanged        INTEGER NOT NULL,
  skipped          INTEGER NOT NULL,
  full_file        BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_master_applies_at ON vendor_master_applies (applied_at DESC, id DESC);

-- An earlier version of this screen recorded each apply on the run itself, in
-- five vendor_master_* columns on msme_reco_runs. Those runs have been applied
-- already -- the master holds their details -- so their counts move here as
-- they are, timed as that version timed them (the run's own uploaded_at), and
-- the columns go. Without this the runs would look unapplied and be applied
-- again from the reco's columns, over the whole-file values they brought.
-- Idempotent: once the columns are gone, nothing here runs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'msme_reco_runs'
                AND column_name = 'vendor_master_added') THEN
    INSERT INTO vendor_master_applies
      (run_id, file_name, sheet_name, run_uploaded_at, uploaded_by, applied_at,
       added, updated, unchanged, skipped, full_file)
    SELECT id, vendor_file_name, vendor_master_sheet, uploaded_at, uploaded_by, uploaded_at,
           vendor_master_added, COALESCE(vendor_master_updated, 0), COALESCE(vendor_master_unchanged, 0), 0,
           COALESCE(vendor_master_full, TRUE)
      FROM msme_reco_runs
     WHERE vendor_master_added IS NOT NULL
    ON CONFLICT (run_id) DO NOTHING;

    ALTER TABLE msme_reco_runs
      DROP COLUMN IF EXISTS vendor_master_sheet,
      DROP COLUMN IF EXISTS vendor_master_added,
      DROP COLUMN IF EXISTS vendor_master_updated,
      DROP COLUMN IF EXISTS vendor_master_unchanged,
      DROP COLUMN IF EXISTS vendor_master_full;
  END IF;
END $$;

-- ==========================================================================
-- OP PHARMACY
--
-- The pharmacies run the same reconciliation as the hospitals -- a GRN report
-- held against a vendor ageing report, with a BPAD register and a bank
-- statement beside them -- from their own four files, uploaded on their own
-- screen (Pharmacy Uploads) and kept in their own seven tables, the ones above
-- over again under a ph_ prefix:
--
--   ph_upload_batches                upload_batches
--   ph_grn_transactions              grn_transactions
--   ph_vendor_ageing                 vendor_ageing
--   ph_reconciliation_results        reconciliation_results
--   ph_bank_statement_transactions   bank_statement_transactions
--   ph_bpad_records                  bpad_records
--   ph_branch_configs                branch_configs
--
-- Their own tables rather than a column on the hospitals' saying which of the
-- two a row is. An upload replaces what is stored by GRN number (see saveBatch
-- in services/ingest.js), and the two number their GRNs independently: in one
-- table, a pharmacy GRN that shared a number with a hospital one would replace
-- it. Apart, neither upload can reach the other's rows, and no hospital query
-- had to change to keep the pharmacies' rows out of the hospitals' figures.
--
-- Each table has every column its hospital twin has, under the same name, so
-- what is written about one reads true of the other and a query written for
-- one can be pointed at the other. Where the pharmacy reports have nothing for
-- a column it stays NULL; where they have something the hospitals' do not, it
-- is a further column at the end. The comments here say only what differs --
-- the reasoning for each table is beside its twin above.
--
-- Written by services/phIngest.js; the readers are services/phExcelParser.js.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS ph_upload_batches (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  grn_file_name      TEXT,
  ageing_file_name   TEXT,
  grn_row_count      INTEGER NOT NULL DEFAULT 0,
  ageing_row_count   INTEGER NOT NULL DEFAULT 0,
  uploaded_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'COMPLETED',
  bank_file_name     TEXT,
  bank_row_count     INTEGER NOT NULL DEFAULT 0,
  bank_account_no    TEXT,
  bpad_file_name     TEXT,
  bpad_row_count     INTEGER NOT NULL DEFAULT 0,
  bpad_matched_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT ph_upload_batches_has_a_file
    CHECK (grn_file_name IS NOT NULL
        OR ageing_file_name IS NOT NULL
        OR bank_file_name IS NOT NULL
        OR bpad_file_name IS NOT NULL)
);

-- Rows from the GRN Purchase report (the pharmacy system's purchase register).
--
--   dpr_no / dpr_date     FeedNo / FeedDate -- the GRN, as the pharmacies number it
--   bill_no / bill_date   InvNo / InvDate
--   vendor_code           PM Code, the pharmacy system's own code for the vendor:
--                         the one the BPAD status files a bill under
--   vendor_name           Name
--   total_amount          NetAmt
--   location              Unit Name ("Secunderabad") -- the stores side's name
--                         for the branch, as the hospitals' Location is
--
-- The register has no serial number, warehouse, PO, DC or transport and
-- add/deduct amounts, so those stay NULL.
CREATE TABLE IF NOT EXISTS ph_grn_transactions (
  id               SERIAL PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES ph_upload_batches(id) ON DELETE CASCADE,
  source_row_no    INTEGER,
  sl_no            INTEGER,
  warehouse        TEXT,
  dpr_no           TEXT NOT NULL,
  dpr_no_key       TEXT NOT NULL,
  po_no            TEXT,
  dpr_date         DATE,
  bill_date        DATE,
  bill_no          TEXT,
  bill_no_key      TEXT,
  dc_no            TEXT,
  vendor_code      TEXT,
  vendor_name      TEXT,
  vendor_name_key  TEXT,
  bill_amount      NUMERIC(18, 4),
  transport_amount NUMERIC(18, 4),
  total_amount     NUMERIC(18, 4),
  location         TEXT,
  add_amount       NUMERIC(18, 4),
  ded_amount       NUMERIC(18, 4),
  -- The purchase register's own. purchase_type is its Type column, Cash or
  -- Credit, which the screens show as Purchase Type. FocusCode is the vendor's
  -- code in the accounts system -- the ageing report's VendorCode -- where
  -- vendor_code above is its code in the pharmacy system.
  purchase_type    TEXT,
  focus_code       TEXT,
  gstin            TEXT,
  tot_taxable      NUMERIC(18, 4),
  cgst             NUMERIC(18, 4),
  sgst             NUMERIC(18, 4),
  igst             NUMERIC(18, 4),
  tcs_amt          NUMERIC(18, 4),
  -- Unit Name folded for comparison -- capitals, letters and digits only, as
  -- every other *_key here is. Half of what a pharmacy GRN is known by: see
  -- "One GRN per number AND unit" below.
  unit_key         TEXT NOT NULL DEFAULT ''
);

-- For a day this column was called payment_type. CREATE TABLE above is a no-op
-- on a table that already exists, so a database migrated during that day has
-- it renamed back here, in place, keeping whatever it holds. Idempotent: where
-- the column is already purchase_type, nothing matches.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ph_grn_transactions' AND column_name = 'payment_type'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ph_grn_transactions' AND column_name = 'purchase_type'
  ) THEN
    ALTER TABLE ph_grn_transactions RENAME COLUMN payment_type TO purchase_type;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ph_grn_batch_key ON ph_grn_transactions (batch_id, dpr_no_key);

-- --------------------------------------------------------------------------
-- One GRN per number AND unit.
--
-- The hospitals know a GRN by its number alone. The pharmacy units number
-- their FeedNos independently, so the same number under two units is two
-- GRNs, and each is matched to the other reports only with its unit: to a
-- Vendor Age row filed under the unit's DivisionCode, and to a BPAD row
-- carrying the unit's Location (the three names being one branch's on
-- Ph-Configuration). So a GRN's identity here is (dpr_no_key, unit_key), and
-- that pair is what an upload replaces by and what the index holds unique.
--
-- unit_key arrived after the table did: added here for a table created
-- without it, and filled from Unit Name by the same fold the upload applies
-- (normKey in services/normalize.js). The unique index on the number alone
-- that the table started with is dropped -- it is what would refuse a second
-- unit's GRN -- and the pair's takes its place. Idempotent throughout.
-- --------------------------------------------------------------------------
ALTER TABLE ph_grn_transactions ADD COLUMN IF NOT EXISTS unit_key TEXT NOT NULL DEFAULT '';

-- Not where the GRN is already on file under that unit: such a pair can only
-- have been left by a server still running the code from before the key
-- existed, and filling this one in would break the unique index below and
-- take the whole migration down with it. The stray stays as it is, keyless.
UPDATE ph_grn_transactions g
   SET unit_key = regexp_replace(upper(COALESCE(g.location, '')), '[^A-Z0-9]', '', 'g')
 WHERE g.unit_key = ''
   AND regexp_replace(upper(COALESCE(g.location, '')), '[^A-Z0-9]', '', 'g') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM ph_grn_transactions o
      WHERE o.id <> g.id
        AND o.dpr_no_key = g.dpr_no_key
        AND o.unit_key = regexp_replace(upper(COALESCE(g.location, '')), '[^A-Z0-9]', '', 'g')
   );

-- The default was only there to add the column to rows that had none. Without
-- it, a server still running the earlier code -- which does not know the
-- column, and replaces a GRN by its number alone -- has its upload refused
-- outright, rather than storing GRNs with no unit and deleting other units'
-- GRNs of the same numbers as it goes. The upload here always gives the key.
ALTER TABLE ph_grn_transactions ALTER COLUMN unit_key DROP DEFAULT;

DROP INDEX IF EXISTS idx_ph_grn_one_per_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_grn_one_per_unit
  ON ph_grn_transactions (dpr_no_key, unit_key) WHERE dpr_no_key <> '';

-- Rows from the pharmacies' Vendor Age report.
--
-- The report leaves GRN_NO empty: the GRN number is the third part of GRNDoc
-- ("PSE/26-27/HE00184" -> "HE00184"), with the document's first part as
-- branch_code. grn_no holds that number -- the GRN number itself, the purchase
-- register's FeedNo, which is what the screens show as GRN No -- and
-- grn_number the same; grn_doc keeps the whole reference.
--
-- division_code is the report's DivisionCode, and it is what ties a row to a
-- branch: a row is matched to a GRN only when it is the Branch code (Focus) of
-- the configured branch whose Unit name (HIS) is the GRN's Unit Name -- see
-- SAME_BRANCH in services/phIngest.js.
--
-- It has no StoreName and none of the six dates before the cheque, so those
-- stay NULL.
CREATE TABLE IF NOT EXISTS ph_vendor_ageing (
  id                   SERIAL PRIMARY KEY,
  batch_id             INTEGER NOT NULL REFERENCES ph_upload_batches(id) ON DELETE CASCADE,
  source_row_no        INTEGER,
  division             TEXT,
  division_code        TEXT,
  store_name           TEXT,
  vendor_name          TEXT,
  vendor_name_key      TEXT,
  vendor_code          TEXT,
  grn_doc              TEXT,
  grn_no               TEXT,
  branch_code          TEXT,
  grn_number           TEXT,
  grn_number_key       TEXT,
  bill_no              TEXT,
  bill_no_key          TEXT,
  bill_date            DATE,
  net_amt              NUMERIC(18, 4),
  adj_pur_return       NUMERIC(18, 4),
  adjusted_jv          NUMERIC(18, 4),
  tds_jv               NUMERIC(18, 4),
  payable_amount       NUMERIC(18, 4),
  indent_date          DATE,
  po_date              DATE,
  security_date        DATE,
  grn_date             DATE,
  bill_to_audit        DATE,
  bill_handover_to_acc DATE,
  chq_date             DATE,
  cheque_clearance_date DATE,
  payment_doc_no       TEXT,
  cheque_no            TEXT,
  balance              NUMERIC(18, 4),
  cheque_clearance_override DATE,
  -- The report's own: what has been paid against the bill so far, and what was
  -- paid ahead of it.
  payment_amt          NUMERIC(18, 4),
  advance_payment_amt  NUMERIC(18, 4),
  -- DivisionCode folded for comparison, as unit_key is on the GRN row. With
  -- the GRN number it is what an ageing row is known and replaced by: the same
  -- number under another division is another unit's document.
  division_key         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ph_ageing_batch_key ON ph_vendor_ageing (batch_id, grn_number_key);
CREATE INDEX IF NOT EXISTS idx_ph_ageing_grn_number_key ON ph_vendor_ageing (grn_number_key, batch_id DESC);

-- division_key for a table created without it, filled from DivisionCode by the
-- upload's own fold. Idempotent.
ALTER TABLE ph_vendor_ageing ADD COLUMN IF NOT EXISTS division_key TEXT NOT NULL DEFAULT '';

UPDATE ph_vendor_ageing
   SET division_key = regexp_replace(upper(COALESCE(division_code, '')), '[^A-Z0-9]', '', 'g')
 WHERE division_key = ''
   AND regexp_replace(upper(COALESCE(division_code, '')), '[^A-Z0-9]', '', 'g') <> '';

CREATE INDEX IF NOT EXISTS idx_ph_ageing_grn_division ON ph_vendor_ageing (grn_number_key, division_key);

-- grn_no on rows stored before it was settled as the GRN number itself: the
-- number is already beside it in grn_number, so it is copied across. Never
-- blanks a value, and idempotent -- once the two agree, nothing matches.
UPDATE ph_vendor_ageing
   SET grn_no = grn_number
 WHERE grn_no IS DISTINCT FROM grn_number
   AND COALESCE(grn_number, '') <> '';

CREATE TABLE IF NOT EXISTS ph_reconciliation_results (
  id                 SERIAL PRIMARY KEY,
  batch_id           INTEGER NOT NULL REFERENCES ph_upload_batches(id) ON DELETE CASCADE,
  grn_transaction_id INTEGER NOT NULL REFERENCES ph_grn_transactions(id) ON DELETE CASCADE,
  matched_ageing_id  INTEGER REFERENCES ph_vendor_ageing(id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('MATCHED', 'MATCHED_WITH_DIFF', 'PENDING')),
  bill_no_match      BOOLEAN,
  vendor_name_match  BOOLEAN,
  discrepancy_notes  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ph_results_batch_status ON ph_reconciliation_results (batch_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_results_one_per_grn
  ON ph_reconciliation_results (grn_transaction_id);
CREATE INDEX IF NOT EXISTS idx_ph_results_ageing ON ph_reconciliation_results (matched_ageing_id);

-- The pharmacies' bank statement is HDFC's own layout, as the hospitals' is.
CREATE TABLE IF NOT EXISTS ph_bank_statement_transactions (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES ph_upload_batches(id) ON DELETE CASCADE,
  source_row_no       INTEGER,
  txn_date            DATE,
  narration           TEXT,
  chq_ref_no          TEXT,
  extracted_cheque_no TEXT,
  value_date          DATE,
  withdrawal_amt      NUMERIC(18, 4),
  deposit_amt         NUMERIC(18, 4),
  closing_balance     NUMERIC(18, 4)
);

CREATE INDEX IF NOT EXISTS idx_ph_bank_batch ON ph_bank_statement_transactions (batch_id);
CREATE INDEX IF NOT EXISTS idx_ph_bank_cheque ON ph_bank_statement_transactions (extracted_cheque_no);

-- Rows from the pharmacies' BPAD current bill status, matched to a GRN on the
-- vendor code -- the purchase register's PM Code -- the GRN number, and the
-- Location being the GRN's unit's Location (BPAD) on Ph-Configuration. The
-- status has PO Number and PO Date in one column; whatever it holds is kept as
-- po_number, and po_date stays NULL.
--
-- unit_key is the unit_key of the GRN the row was matched to. It is what ties
-- a stored row -- the status's own, or the one written for a GRN the status
-- had no entry for, which has no Location to go by -- back to that GRN where
-- two units have a GRN of the same number.
CREATE TABLE IF NOT EXISTS ph_bpad_records (
  id                     SERIAL PRIMARY KEY,
  batch_id               INTEGER NOT NULL REFERENCES ph_upload_batches(id) ON DELETE CASCADE,
  source_row_no          INTEGER,
  sl_no                  INTEGER,
  location               TEXT,
  warehouse              TEXT,
  vendor_code            TEXT,
  vendor_code_key        TEXT,
  vendor_name            TEXT,
  inv_no                 TEXT,
  inv_date               DATE,
  grn_no                 TEXT,
  grn_no_key             TEXT,
  grn_date               DATE,
  grn_amount             NUMERIC(18, 4),
  po_number              TEXT,
  po_date                DATE,
  pending_with_dept      TEXT,
  bpad_received_date     DATE,
  accounts_received_date DATE,
  pending_with_user      TEXT,
  pend_reason            TEXT,
  in_register            BOOLEAN NOT NULL DEFAULT TRUE,
  unit_key               TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ph_bpad_batch ON ph_bpad_records (batch_id);
CREATE INDEX IF NOT EXISTS idx_ph_bpad_grn_no_key ON ph_bpad_records (grn_no_key, batch_id DESC);

-- unit_key for a table created without it. A row stored before it existed is
-- given its GRN's unit where that can only be one unit -- the number and the
-- vendor code name a single GRN on file. Where they name more than one, the
-- row is left without, and is replaced the next time the status is uploaded.
-- Idempotent.
ALTER TABLE ph_bpad_records ADD COLUMN IF NOT EXISTS unit_key TEXT NOT NULL DEFAULT '';

UPDATE ph_bpad_records b
   SET unit_key = one.unit_key
  FROM (
    SELECT g.dpr_no_key,
           regexp_replace(upper(COALESCE(g.vendor_code, '')), '[^A-Z0-9]', '', 'g') AS vendor_code_key,
           MIN(g.unit_key) AS unit_key
      FROM ph_grn_transactions g
     WHERE g.unit_key <> ''
     GROUP BY 1, 2
    HAVING COUNT(DISTINCT g.unit_key) = 1
  ) one
 WHERE b.unit_key = ''
   AND b.grn_no_key = one.dpr_no_key
   AND b.vendor_code_key = one.vendor_code_key;

CREATE INDEX IF NOT EXISTS idx_ph_bpad_grn_unit ON ph_bpad_records (grn_no_key, unit_key);

-- Pharmacy branches, as configured on the Ph-Configuration screen. What each
-- column is matched against:
--
--   branch_code    the Vendor Age report's DivisionCode        ("PSE")
--   location       the GRN Purchase report's Unit Name          ("Secunderabad")
--   account_no     the account its bank statement is for        ("99995542441111")
--   bpad_location  the BPAD current bill status's Location      ("SBD1")
--
-- `location` keeps the hospital table's name for the column although the
-- screen calls it Unit name (HIS): it is the stores side's name for the
-- branch in both, and is matched the same way.
CREATE TABLE IF NOT EXISTS ph_branch_configs (
  id            SERIAL PRIMARY KEY,
  branch_code   TEXT NOT NULL,
  location      TEXT NOT NULL,
  account_no    TEXT,
  is_selected   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bpad_location TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_branch_code ON ph_branch_configs (upper(branch_code));
CREATE INDEX IF NOT EXISTS idx_ph_branch_selected ON ph_branch_configs (is_selected);

-- --------------------------------------------------------------------------
-- One pharmacy handover to CSD: a GRN taken off Pharmacy Results and passed on.
--
-- csd_dispatches for the pharmacies, column for column -- see the comments
-- there for what each is and why the GRN's details are copied in rather than
-- joined to. The CS Department screen shows this table under its "OP Pharmacy
-- CSD" view and the hospitals' under "Hospital CSD" (routes/phCsd.js).
--
-- What differs is the key. A pharmacy GRN is its number AND its unit (see "One
-- GRN per number AND unit" above), so a handover is too: unit_key is the
-- GRN's own, and the pair is what is held unique -- one live handover per GRN,
-- which is what lets Pharmacy Results join to this table without multiplying
-- its rows, with two units' GRNs of one number each free to be handed over.
--
-- `location` is the GRN's Unit Name, as it is on ph_grn_transactions.
--
-- The Accounts columns (accounts_stage onwards) are the hospitals' too.
-- accounts_stage is started by the Moved to accounts move, as it is there;
-- nothing reads the rest yet -- Ph-Accounts is not built -- and they are here
-- so that it needs no change to this table when it is.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ph_csd_dispatches (
  id                     SERIAL PRIMARY KEY,
  dpr_no_key             TEXT NOT NULL,
  unit_key               TEXT NOT NULL DEFAULT '',
  dpr_no                 TEXT NOT NULL,
  division_code          TEXT,
  location               TEXT,
  dpr_date               DATE,
  bill_no                TEXT,
  bill_date              DATE,
  vendor_code            TEXT,
  vendor_name            TEXT,
  -- The Vendor Age report's document reference, GRNDoc ("PSE/26-27/HE00184"),
  -- or the GRN number taken from it where a row has no GRNDoc.
  ageing_grn_no          TEXT,
  net_amt                NUMERIC(18, 4),
  adj_pur_return         NUMERIC(18, 4),
  adjusted_jv            NUMERIC(18, 4),
  tds_jv                 NUMERIC(18, 4),
  payable_amount         NUMERIC(18, 4),
  cheque_no              TEXT,
  chq_date               DATE,
  payment_doc_no         TEXT,
  status                 TEXT,
  discrepancy_notes      TEXT,
  stage                  TEXT NOT NULL DEFAULT 'QUEUED'
                           CHECK (stage IN ('QUEUED', 'RECEIVED', 'APPROVED', 'REJECTED', 'MOVED_TO_ACCOUNTS')),
  stage_at               TIMESTAMPTZ,
  stage_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at            TIMESTAMPTZ,
  approved_at            TIMESTAMPTZ,
  rejected_at            TIMESTAMPTZ,
  moved_to_accounts_at   TIMESTAMPTZ,
  reject_remarks         TEXT,
  accounts_stage         TEXT CHECK (accounts_stage IN ('QUEUED', 'RECEIVED')),
  accounts_received_at   TIMESTAMPTZ,
  accounts_received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  forwarded_to           TEXT CHECK (forwarded_to IN ('BANK', 'VENDOR', 'OTHERS', 'COURIER')),
  forwarded_route        TEXT CHECK (forwarded_route IN ('VENDOR', 'PURCHASE_DEPT')),
  forwarded_name         TEXT,
  forwarded_mobile       TEXT,
  forwarded_date         DATE,
  forwarded_remarks      TEXT,
  forwarded_courier_name TEXT,
  forwarded_docket_no    TEXT,
  forwarded_at           TIMESTAMPTZ,
  forwarded_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- SET NULL rather than CASCADE: removing an upload must not remove the
  -- record that the GRN went to CSD.
  batch_id               INTEGER REFERENCES ph_upload_batches(id) ON DELETE SET NULL,
  sent_by                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The vendor's Focus code, as the GRN Purchase report carries it beside the PM
-- Code. It is the code the Vendor Master knows a pharmacy vendor by -- the PM
-- Code is the pharmacy system's own, and is on no master -- so it is what the
-- queue's MSME, Inter and Supply Type columns are looked up with
-- (services/vendorMsme.js). Snapshotted like every other field here; filled
-- for a handover made before the column existed from the GRN it was made for,
-- where that GRN is still on file.
ALTER TABLE ph_csd_dispatches ADD COLUMN IF NOT EXISTS focus_code TEXT;

UPDATE ph_csd_dispatches c
   SET focus_code = g.focus_code
  FROM ph_grn_transactions g
 WHERE c.focus_code IS NULL
   AND g.dpr_no_key = c.dpr_no_key
   AND g.unit_key = c.unit_key
   AND COALESCE(g.focus_code, '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_csd_one_per_unit ON ph_csd_dispatches (dpr_no_key, unit_key);
CREATE INDEX IF NOT EXISTS idx_ph_csd_sent_at ON ph_csd_dispatches (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_ph_csd_stage ON ph_csd_dispatches (stage);
CREATE INDEX IF NOT EXISTS idx_ph_csd_cheque ON ph_csd_dispatches (cheque_no);

-- Pharmacy rejections that a later upload reopened -- csd_rejection_history
-- for the pharmacies, with the unit a handover is known by. See
-- reopenRejectedFor in services/phIngest.js.
CREATE TABLE IF NOT EXISTS ph_csd_rejection_history (
  id                     SERIAL PRIMARY KEY,
  dpr_no_key             TEXT NOT NULL,
  unit_key               TEXT NOT NULL DEFAULT '',
  dpr_no                 TEXT NOT NULL,
  division_code          TEXT,
  location               TEXT,
  bill_no                TEXT,
  vendor_code            TEXT,
  vendor_name            TEXT,
  cheque_no              TEXT,
  payable_amount         NUMERIC(18, 4),
  reject_remarks         TEXT,
  rejected_at            TIMESTAMPTZ,
  rejected_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at                TIMESTAMPTZ,
  sent_by                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  superseded_by_batch_id INTEGER REFERENCES ph_upload_batches(id) ON DELETE SET NULL,
  superseded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ph_csd_rejection_history_key
  ON ph_csd_rejection_history (dpr_no_key, unit_key);

-- --------------------------------------------------------------------------
-- A pharmacy GRN handed to Records -- record_dispatches for the pharmacies:
-- the other destination a GRN in accounts can be sent to from Pharmacy
-- Results, beside CSD. As thin as the hospitals', and for the same reason:
-- Records has no queue and no stages, so nothing is read back but the fact
-- that the GRN went, beside the results row it belongs to.
--
-- Keyed on the number AND the unit, as every pharmacy record of a GRN is, so
-- two units' GRNs of one number are filed separately -- and the pair is what
-- lets Pharmacy Results join to this table without multiplying its rows.
-- `location` is the Unit Name as the report wrote it, kept so the activity
-- log can say which unit's GRN was filed.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ph_record_dispatches (
  id         SERIAL PRIMARY KEY,
  dpr_no_key TEXT NOT NULL,
  unit_key   TEXT NOT NULL DEFAULT '',
  dpr_no     TEXT NOT NULL,
  location   TEXT,
  batch_id   INTEGER REFERENCES ph_upload_batches(id) ON DELETE SET NULL,
  sent_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ph_record_one_per_unit ON ph_record_dispatches (dpr_no_key, unit_key);
CREATE INDEX IF NOT EXISTS idx_ph_record_sent_at ON ph_record_dispatches (sent_at DESC);
