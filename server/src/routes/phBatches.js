/**
 * OP Pharmacy's uploads -- the Pharmacy Uploads screen.
 *
 * routes/batches.js for the pharmacies' four files: the GRN Purchase report,
 * the Vendor Age report, the BPAD current bill status and the bank statement.
 * The same four slots under the same caps, read by the pharmacies' own readers
 * (services/phExcelParser.js) and stored in the pharmacies' own tables
 * (services/phIngest.js), so nothing uploaded here can reach a hospital row.
 *
 * Whatever does not touch a table is the hospital route's own, imported: the
 * multer instance and its caps, the size check, and how several files in one
 * slot are merged. What does -- which GRNs the BPAD status is read against,
 * and what each branch is called -- is written again here against the ph_
 * tables.
 *
 * Behind the same `upload` grant as the hospital screen. An account that may
 * upload sees both New uploads and Pharmacy Uploads in the sidebar, and the
 * API should not disagree with the menu about what it may do.
 */
import express from 'express';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { readBankStatement } from '../services/excelParser.js';
import { readPhGrnReport, readPhAgeingReport, readPhBpadReport } from '../services/phExcelParser.js';
import { normKey } from '../services/normalize.js';
import { lastRowPerUnitGrn, savePhBatch } from '../services/phIngest.js';
import { logActivity } from '../services/activityLog.js';
import {
  MAX_FILES_PER_SLOT,
  MAX_BPAD_FILES,
  upload,
  tooLargeMessage,
  refuseOversizedUpload,
  defaultBatchName,
  readEach,
  lastFilePerKey,
  fileNames,
  bpadLocationMismatch,
} from './batches.js';

export const phBatchesRouter = express.Router();

phBatchesRouter.use(requireAuth);

/** GET /api/op-pharmacy/batches/limits - the caps, for checking files as they are picked. */
phBatchesRouter.get('/limits', requireScreen('upload'), (req, res) => {
  res.json({
    maxFileBytes: config.maxUploadBytes,
    maxTotalBytes: config.maxUploadTotalBytes,
    maxFilesPerSlot: MAX_FILES_PER_SLOT,
    maxBpadFiles: MAX_BPAD_FILES,
  });
});

/* ==========================================================================
   The branch, and what goes through it.

   The three reports each call a branch something different -- the purchase
   register "Secunderabad", the ageing report "PSE", the BPAD status "SBD1" --
   so no two of them can be held against each other directly. Ph-Configuration
   is where somebody has said the three names are one place, and a GRN is
   matched to the other two reports only through it:

     GRN Purchase report      Vendor Age report         BPAD current bill status
     FeedNo                   GRN number (in GRNDoc)    GRN No
     PM Code                                            Vendor Code
     Unit Name                DivisionCode              Location
       = Unit name (HIS)        = Branch code (Focus)     = Location (BPAD)
                              ...of one and the same branch

   This is stricter than the hospitals', where a row nobody has configured a
   branch for is matched on its numbers alone. Here a GRN whose Unit Name is
   not configured is matched to neither report: without the configuration there
   is nothing to say a row carrying the right GRN number is not another unit's.

   And it may well be. The units number their FeedNos independently, so one
   number under two units is two GRNs (see "What a pharmacy GRN is known by" in
   services/phIngest.js) -- each stored on its own, each matched to the ageing
   row filed under its own division, and each given the status row written
   under its own Location.

   The ageing half of the rule is applied where the result is worked out, in
   SQL (SAME_BRANCH in services/phIngest.js); what is here is the BPAD half,
   and the checks that refuse an upload the configuration cannot place.

   The functions down to matchBpadFiles are exported so the rules can be run
   against real files without a request or a table -- none of them reads one.
   ========================================================================== */

/** One ph_branch_configs row, as the matching reads it: each name, folded. */
export function toBranch(row) {
  return {
    branchCode: row.branch_code,
    unitName: row.location,
    bpadLocation: row.bpad_location,
    branchKey: normKey(row.branch_code),
    unitKey: normKey(row.location),
    bpadLocationKey: normKey(row.bpad_location),
  };
}

/** "A", "A and B", "A, B and C". */
function listed(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** How many of `what`, with the word in the singular for one. */
function counted(n, what) {
  return `${n.toLocaleString('en-IN')} ${what}${n === 1 ? '' : 's'}`;
}

/** A name as a message quotes it, or "(blank)". */
function quoted(name) {
  return name ? `"${name}"` : '(blank)';
}

/**
 * `rows` grouped by `nameOf`, as `[{ name, count }]`, largest first -- for
 * saying which names a check turned up, and how much of the file each is.
 */
function tally(rows, nameOf) {
  const counts = new Map();
  for (const row of rows) {
    const name = String(nameOf(row) ?? '').trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/* --------------------------------------------------------------------------
   The Vendor Age report: DivisionCode against Branch code (Focus).
   -------------------------------------------------------------------------- */

/**
 * The ageing rows whose DivisionCode is no configured branch's Branch code
 * (Focus), by code -- or `{ error }` when that is every row of the report.
 *
 * A row like that is matched to no GRN (SAME_BRANCH in services/phIngest.js),
 * so a report made of nothing else would be stored and leave every GRN it is
 * about reading as pending -- which says the bills have not reached accounts,
 * when what is wrong is a setting. That upload is refused, with the code the
 * report writes, so the message says what to enter.
 *
 * A report where only some rows are like that is stored whole: the other
 * divisions' rows do no harm on file, and are matched as soon as a branch is
 * configured for them (relinkPhResults). They are counted for the answer.
 */
export function checkAgeingDivisions(ageingRows, branches) {
  const configured = new Set(branches.map((b) => b.branchKey).filter(Boolean));
  const strays = ageingRows.filter((row) => !configured.has(normKey(row.divisionCode)));
  const divisions = tally(strays, (row) => row.divisionCode);

  if (ageingRows.length > 0 && strays.length === ageingRows.length) {
    const codes = divisions.slice(0, 5).map((d) => `${quoted(d.name)} (${counted(d.count, 'row')})`);
    const have = branches.map((b) => quoted(b.branchCode));
    return {
      error:
        `The Vendor Age report cannot be matched: its DivisionCode is ${listed(codes)}, and ` +
        `Ph-Configuration has no branch with ${divisions.length === 1 ? 'that' : 'any of those'} as its ` +
        `Branch code (Focus)${have.length > 0 ? ` -- the branches there are ${listed(have)}` : ''}. ` +
        `A Vendor Age row is matched to a GRN only when the row's DivisionCode and the GRN's Unit Name ` +
        `are one branch's Branch code (Focus) and Unit name (HIS). ` +
        'Add or correct the branch on the Ph-Configuration screen and upload again. ' +
        'Nothing from this upload was stored.',
    };
  }

  return { unconfigured: { rowCount: strays.length, divisions } };
}

/**
 * The GRNs of this upload whose Unit Name is no configured branch's Unit name
 * (HIS), by unit. They are stored like any other, and matched to no ageing row
 * until a branch is configured for the unit -- so the answer says how many.
 */
export function unconfiguredGrnUnits(grnRows, branches) {
  const configured = new Set(branches.map((b) => b.unitKey).filter(Boolean));
  const strays = grnRows.filter((row) => !configured.has(normKey(row.location)));
  return { grnCount: strays.length, units: tally(strays, (row) => row.location) };
}

/* --------------------------------------------------------------------------
   The BPAD status: Location against Location (BPAD).
   -------------------------------------------------------------------------- */

/** A parsed GRN Purchase row, as the BPAD match reads it. */
export function grnForBpad(row) {
  return {
    vendorCode: row.vendorCode,
    vendorName: row.vendorName,
    grnNo: row.dprNo,
    grnNoKey: row.dprNoKey,
    grnDate: row.dprDate,
    grnAmount: row.totalAmount,
    // The purchase register has no PO.
    poNumber: null,
    invNo: row.billNo,
    invDate: row.billDate,
    unitName: row.location,
    unitKey: row.unitKey ?? normKey(row.location),
  };
}

/**
 * The BPAD Locations a GRN's status rows may carry: the Location (BPAD) of
 * every configured branch whose Unit name (HIS) is the GRN's own Unit Name.
 *
 * The two unit names are compared through normKey, as every other key here is,
 * so "Secunderabad", "SECUNDERABAD" and "Secunderabad " are one unit -- but
 * they have to be the same name, not one inside the other. A unit is a short
 * name of its own, unlike the hospitals' GRN Location, which carries the
 * branch somewhere inside a company name and has to be searched for it.
 *
 * Null when no branch is configured for the unit, or none of them has a
 * Location (BPAD): such a GRN is not matched to the status -- see above.
 */
export function bpadLocationsForUnit(unitName, branches) {
  const unitKey = normKey(unitName);
  if (!unitKey) return null;
  const keys = branches
    .filter((b) => b.unitKey === unitKey && b.bpadLocationKey !== '')
    .map((b) => b.bpadLocationKey);
  return keys.length > 0 ? new Set(keys) : null;
}

/**
 * The GRNs the status is read against, keyed by `VENDORCODE|GRNNUMBER` -- under
 * each key, every unit's GRN of that vendor and number, since the number alone
 * does not say which unit's bill a status row is about. Each has `unitKey` and
 * `bpadLocationKeys`: the Locations its status rows may carry, or null where
 * its unit is not configured.
 *
 * The vendor code is the purchase register's PM Code, which is the code the
 * status files a bill under: on the sample, every one of the status's 12,446
 * rows names a GRN in the register under exactly that code.
 *
 * Within a unit, first writer wins, so `grns` is handed over newest first
 * where one GRN can arrive more than once.
 */
export function indexGrnsForBpad(grns, branches) {
  const identities = new Map();
  for (const grn of grns) {
    const vendorCodeKey = normKey(grn.vendorCode);
    if (!vendorCodeKey || !grn.grnNoKey) continue;
    const unitKey = grn.unitKey ?? normKey(grn.unitName);
    const key = `${vendorCodeKey}|${grn.grnNoKey}`;
    const sharing = identities.get(key) ?? [];
    if (sharing.some((id) => id.unitKey === unitKey)) continue;
    sharing.push({
      ...grn,
      vendorCodeKey,
      unitKey,
      bpadLocationKeys: bpadLocationsForUnit(grn.unitName, branches),
    });
    identities.set(key, sharing);
  }
  return identities;
}

/** Every GRN in `identities`, whichever number it is filed under. */
function everyGrn(identities) {
  return [...identities.values()].flat();
}

/**
 * The units among `grns` that Ph-Configuration does not have with a Location
 * (BPAD), largest first, and how many GRNs they come to.
 */
function unconfiguredUnits(grns) {
  const strays = grns.filter((id) => !id.bpadLocationKeys);
  return { grnCount: strays.length, units: tally(strays, (id) => id.unitName) };
}

/**
 * The GRNs a status row is about: of the ones sharing its vendor code and GRN
 * number, those whose unit is configured with the Location the row carries.
 *
 * One, nearly always. More than one only where two units share both a number
 * and a Location (BPAD) -- and there the row's Inv.No. settles it, where it is
 * the bill number of some of them and not of the others. Where it does not,
 * the row is every such GRN's: the status has said where the bill under that
 * number at that Location is, and nothing says which unit's bill it meant.
 */
function grnsForBpadRow(sharing, locationKey, invNo) {
  const located = sharing.filter((id) => id.bpadLocationKeys?.has(locationKey));
  if (located.length < 2) return located;
  const invNoKey = normKey(invNo);
  const billed = invNoKey ? located.filter((id) => normKey(id.invNo) === invNoKey) : [];
  return billed.length > 0 ? billed : located;
}

/**
 * The row stored for a GRN the status has no entry for -- bpadRowsForGrns in
 * routes/batches.js, which says why such a row is written at all and why it
 * carries so little, with the unit the GRN is known by.
 */
function noEntryRow(id) {
  return {
    sourceRowNo: null,
    slNo: null,
    location: null,
    warehouse: null,
    vendorCode: id.vendorCode,
    vendorCodeKey: id.vendorCodeKey,
    vendorName: id.vendorName,
    invNo: id.invNo,
    invDate: id.invDate,
    grnNo: id.grnNo,
    grnNoKey: id.grnNoKey,
    grnDate: id.grnDate,
    grnAmount: id.grnAmount,
    poNumber: id.poNumber,
    poDate: null,
    pendingWithDept: null,
    bpadReceivedDate: null,
    accountsReceivedDate: null,
    pendingWithUser: null,
    pendReason: null,
    inRegister: false,
    unitKey: id.unitKey,
  };
}

/**
 * Why the upload is refused when not one of its GRNs can be matched to the
 * status: every unit they name is missing from Ph-Configuration, or is there
 * without a Location (BPAD).
 *
 * Refused rather than stored with nothing matched. The status would otherwise
 * go in as a file that "matched 0 rows", which reads like a wrong file rather
 * than a missing setting -- and the message can say exactly what to enter: the
 * unit as the purchase register writes it, and the Locations the status holds.
 */
function notConfiguredMessage(unconfigured, fileLocations) {
  const units = unconfigured.units.slice(0, 5).map((u) => `${quoted(u.name)} (${counted(u.count, 'GRN')})`);
  const locations = [...fileLocations]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, n]) => `${key || '(blank)'} (${counted(n, 'row')})`);
  return (
    `The BPAD bill status cannot be matched: Ph-Configuration has no branch with a Location (BPAD) ` +
    `for Unit Name ${listed(units)}. A BPAD row is matched to a GRN only when the GRN's Unit Name and ` +
    `the row's Location are one branch's Unit name (HIS) and Location (BPAD). ` +
    `The BPAD file's Location column has ${listed(locations)}. ` +
    'Add the branch, or fill in its Location (BPAD), on the Ph-Configuration screen and upload again. ' +
    'Nothing from this upload was stored.'
  );
}

/**
 * Why the upload is refused when a unit's Location (BPAD) is in the status but
 * the rows about its GRNs are mostly written under another one -- see where
 * matchBpadFiles builds `swapped`.
 */
function swappedLocationMessage(swapped) {
  const problems = swapped.map(({ own, location, away, kept }) => {
    const names = own.map((b) => `${b.branchCode} has Location (BPAD) "${b.bpadLocation}"`).join(' and ');
    return (
      `${names}, but the BPAD bill status writes ${counted(away, 'row')} about this unit's GRNs under ` +
      `${location || '(blank)'} and ${kept === 0 ? 'none' : `only ${kept.toLocaleString('en-IN')}`} under its own.`
    );
  });
  return (
    `${problems.join(' ')} Two branches' Location (BPAD) look swapped, or set to the same one. ` +
    'Correct Location (BPAD) on the Ph-Configuration screen and upload again. Nothing from this upload was stored.'
  );
}

/**
 * Read the status files against `identities` and settle what is stored.
 *
 * A row is kept when its Vendor Code and GRN No are a GRN's and its Location
 * is one that GRN's unit is configured with -- and it is kept for that unit's
 * GRN, whichever other units have one of the same number (grnsForBpadRow). The
 * rest are read past, and counted by why:
 *
 *  - `unconfigured.rowCount`: a GRN of that number has no Location (BPAD) to
 *    be held against, so the row may be its own and nothing can say -- it was
 *    not considered;
 *  - `otherBranchCount`: every GRN of that number has its unit configured, and
 *    the row's Location is none of theirs -- another unit's bill under the
 *    number.
 *
 * Then every GRN the files answer for gets a row: the status's own, or one
 * saying the status has no entry for it (noEntryRow). The files answer for a
 * GRN when its unit is configured AND they carry at least one row under one of
 * that unit's Locations. A status that never writes a unit's Location is not
 * saying that unit's bills are missing from BPAD -- it is another unit's
 * export -- so those GRNs get nothing, and whatever is stored for them stays
 * (`notCovered`). The same for a GRN whose unit is not configured. And the
 * same for a GRN from an earlier report (`listedOnly`) that a status uploaded
 * beside a GRN report does not list (`unlistedCount`): that status answers
 * for the report's own GRNs, and moves an earlier one only by listing it.
 * Nothing is stored for those either -- but the ones whose unit gets its
 * first status rows from this upload are held by that from now on, and are
 * counted apart (`unlistedNewlyHeldCount`).
 *
 * Returns `{ error }` when the upload has to be refused: a Location (BPAD)
 * that looks mistyped (bpadLocationMismatch) or swapped with another branch's
 * (swappedLocationMessage), or no GRN that can be matched at all
 * (notConfiguredMessage). With no GRNs to read against there is nothing to
 * refuse -- the status is stored as a file that matched nothing, as before.
 */
export function matchBpadFiles(files, identities, branches) {
  // Every Location the files write, folded, and how many rows carry it; how
  // many of those rows were kept, by Location and by the unit they were kept
  // for; and the rows turned away, by the Location that would have kept them
  // and by the unit whose GRN they named.
  const fileLocations = new Map();
  const keptAt = new Map();
  const keptFor = new Map();
  const turnedAway = new Map();
  const awayFrom = new Map();
  let otherBranchCount = 0;
  let unconfiguredRowCount = 0;

  const bump = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const bumpIn = (maps, key, inner) => {
    const counts = maps.get(key) ?? new Map();
    bump(counts, inner);
    maps.set(key, counts);
  };

  const keep = (vendorCodeKey, grnNoKey, locationKey) => {
    bump(fileLocations, locationKey);
    const sharing = identities.get(`${vendorCodeKey}|${grnNoKey}`);
    if (!sharing) return false;
    const located = sharing.filter((id) => id.bpadLocationKeys?.has(locationKey));
    if (located.length > 0) {
      bump(keptAt, locationKey);
      for (const unitKey of new Set(located.map((id) => id.unitKey))) bump(keptFor, unitKey);
      return true;
    }
    // Nobody's by its Location. Where one of the GRNs it could be about has no
    // Location (BPAD) to be held against, it may well be that one's -- so it is
    // counted as unconfigured, and is no evidence against the others' settings.
    if (sharing.some((id) => !id.bpadLocationKeys)) {
      unconfiguredRowCount += 1;
      return false;
    }
    otherBranchCount += 1;
    for (const required of new Set(sharing.flatMap((id) => [...id.bpadLocationKeys]))) {
      bumpIn(turnedAway, required, locationKey);
    }
    for (const unitKey of new Set(sharing.map((id) => id.unitKey))) bumpIn(awayFrom, unitKey, locationKey);
    return false;
  };

  const bpads = readEach(files, 'BPAD current bill status', (buffer) => readPhBpadReport(buffer, { keep }));

  const grns = everyGrn(identities);

  // Rows turned away are evidence of a wrong Location (BPAD) only where the
  // Location they do carry is not, in the main, being kept for its own unit's
  // GRNs. Numbers are shared between units, so a status written wholly under
  // "SBD1" will name a few GRNs that only another unit has on file -- and that
  // is that unit's number turning up, not its Location being wrong. Where the
  // rows under a Location are turned away more often than they are kept, it is
  // the setting.
  //
  // And never where the Location is a branch's whose unit has no GRN on hand:
  // rows under it cannot be kept whatever the settings say, so being turned
  // away from another unit's GRN of the same number tells nothing.
  const unitsOnHand = new Set(grns.map((id) => id.unitKey));
  const tellsNothing = (location) => {
    const owners = branches.filter((b) => b.bpadLocationKey !== '' && b.bpadLocationKey === location);
    return owners.length > 0 && !owners.some((b) => unitsOnHand.has(b.unitKey));
  };
  const outnumbersKept = ([location, n]) => !tellsNothing(location) && n > (keptAt.get(location) ?? 0);

  // For the Location-never-written check they also have to be the bulk of what
  // the files write under that Location. A mistyped Location (BPAD) has nearly
  // every row under the real one turned away; another unit's number turning up
  // is a handful among the rows of a unit that is not configured yet, or has
  // little on hand -- and now that every GRN on file is read against, that
  // must not be blamed on a branch that is set correctly. Missing a real
  // mistype here stores nothing wrong where none of the unit's Locations is in
  // the files: its GRNs are notCovered, below. (The swapped check further down
  // keeps outnumbersKept as it is: there both Locations are in the files, and
  // wrong rows would be stored.)
  const bulkOfLocation = ([location, n]) => n * 2 > (fileLocations.get(location) ?? 0);

  // ...but only where missing the mistype really does store nothing. A GRN is
  // notCovered only when NONE of its unit's Locations is in the files, so
  // where a branch that has `required` shares its Unit name with a branch
  // whose Location the files do write, that unit's GRNs are covered and would
  // be given "no entry" rows -- there the test stays outnumbersKept alone, for
  // rows under a Location no branch holds.
  const unitIsCovered = (required) =>
    branches.some(
      (b) =>
        b.unitKey !== '' &&
        b.bpadLocationKey === required &&
        branches.some(
          (o) => o.unitKey === b.unitKey && o.bpadLocationKey !== '' && fileLocations.has(o.bpadLocationKey),
        ),
    );

  // ...and only for those: a Location no branch is configured with is what a
  // mistyped Location's real one is. Rows under another branch's own Location
  // are that branch's rows naming a number this unit also has; they keep the
  // bulkOfLocation test, so a branch that is set correctly is not blamed for
  // them.
  const heldByABranch = (location) =>
    branches.some((b) => b.bpadLocationKey !== '' && b.bpadLocationKey === location);

  const suspect = new Map();
  for (const [required, seen] of turnedAway) {
    const strict = unitIsCovered(required);
    const odd = new Map(
      [...seen].filter(
        (entry) => outnumbersKept(entry) && ((strict && !heldByABranch(entry[0])) || bulkOfLocation(entry)),
      ),
    );
    if (odd.size > 0) suspect.set(required, odd);
  }

  // The hospitals' check, worded for this screen and this file: a configured
  // Location the files never write, with rows turned away for it. canClear is
  // false: clearing a Location (BPAD) is no way out here -- the unit would
  // then not be matched at all.
  const mismatch = bpadLocationMismatch(suspect, new Set(fileLocations.keys()), branches, {
    screen: 'Ph-Configuration',
    canClear: false,
    file: 'BPAD bill status',
    fileShort: 'file',
  });
  if (mismatch) return { error: mismatch };

  // What that check cannot see, because it stops at any Location the files do
  // write: two branches with their Locations swapped, or given the same one,
  // and a status that carries both. Each wrong Location is in the files then,
  // so nothing looks missing -- and the rows would be stored against the other
  // unit's GRN wherever a number is shared, with "no entry" written over every
  // other GRN's status. Judged per unit: more of the rows naming its GRNs
  // turned away under one Location than kept under its own.
  const swapped = [];
  for (const [unitKey, seen] of awayFrom) {
    const own = branches.filter((b) => b.unitKey === unitKey && b.bpadLocationKey !== '');
    if (!own.some((b) => fileLocations.has(b.bpadLocationKey))) continue;
    const kept = keptFor.get(unitKey) ?? 0;
    const [worst] = [...seen].filter(outnumbersKept).sort((a, b) => b[1] - a[1]);
    if (worst && worst[1] > kept) swapped.push({ own, location: worst[0], away: worst[1], kept });
  }
  if (swapped.length > 0) return { error: swappedLocationMessage(swapped) };

  const eligible = grns.filter((id) => id.bpadLocationKeys);
  const unconfigured = unconfiguredUnits(grns);
  if (grns.length > 0 && eligible.length === 0) {
    return { error: notConfiguredMessage(unconfigured, fileLocations) };
  }

  // Each kept row, once for the GRN it is about, with that GRN's unit on it --
  // which is what it is stored and replaced by from here on.
  const keyOf = (r) => `${r.vendorCodeKey}|${r.grnNoKey}|${r.unitKey}`;
  const registerRows = lastFilePerKey(
    bpads.map((b) =>
      b.rows.flatMap((row) =>
        grnsForBpadRow(
          identities.get(`${row.vendorCodeKey}|${row.grnNoKey}`) ?? [],
          normKey(row.location),
          row.invNo,
        ).map((id) => ({ ...row, unitKey: id.unitKey })),
      ),
    ),
    keyOf,
  );

  const seen = new Set(registerRows.map(keyOf));
  const noEntry = [];
  const notCovered = [];
  // GRNs from earlier reports that a status uploaded beside a GRN report does
  // not list: nothing is stored or replaced for them -- see grnMatchKeys. Not
  // notCovered: their Location IS in the files.
  const unlisted = [];
  for (const id of eligible) {
    if (seen.has(keyOf(id))) continue;
    if (![...id.bpadLocationKeys].some((location) => fileLocations.has(location))) notCovered.push(id);
    else if (id.listedOnly) unlisted.push(id);
    else noEntry.push(noEntryRow(id));
  }

  const rows = [...registerRows, ...noEntry];
  // "Left as they were" is true of an unlisted GRN only where its unit already
  // had a status on file: it keeps the row it has, or was held by its unit
  // already. Where this upload stores the unit's FIRST rows, a status is on
  // file for the unit from now on, and an earlier GRN with no row of its own
  // reads as pending at the GRN store (BPAD_ON_FILE in routes/phResults.js) --
  // so those are counted apart, for the answer to say so. `=== false`: a GRN
  // indexed without the flag (indexGrnsForBpad called directly) is not one.
  const storedUnits = new Set(rows.map((r) => r.unitKey));
  const newlyHeld = unlisted.filter((id) => id.unitHadStatus === false && storedUnits.has(id.unitKey));

  return {
    bpads,
    rows,
    // The status's own rows that were kept, counted after the files were
    // merged -- several files naming one GRN count once -- and the GRNs the
    // status had no entry for. The two the answer's sentence is made of.
    matchedCount: registerRows.length,
    noEntryCount: noEntry.length,
    unlistedCount: unlisted.length - newlyHeld.length,
    unlistedNewlyHeldCount: newlyHeld.length,
    otherBranchCount,
    unconfigured: { ...unconfigured, rowCount: unconfiguredRowCount },
    // GRNs of configured units whose Location the files never write.
    notCovered: { grnCount: notCovered.length, units: tally(notCovered, (id) => id.unitName) },
  };
}

/**
 * The GRNs the status is read against: the GRN Purchase rows of this upload,
 * and every other pharmacy GRN on file, newest upload first.
 *
 * Every one on file, where the hospital upload reads its register against the
 * GRN report beside it and nothing else. A pharmacy GRN is in Accounts only
 * while the latest status has its bill at Accounts' desk (BEFORE_ACCOUNTS in
 * routes/phResults.js), so a status that lists a GRN from an earlier report
 * has to be able to move it: read against the report beside it alone, that
 * GRN would keep the desk an older status had it at for good.
 *
 * But only to be moved by a row that lists it. Beside a GRN report, the
 * status answers "no entry" for that report's GRNs and for no others
 * (`listedOnly`; see matchBpadFiles): a status exported for the report's own
 * period says nothing of an earlier period's bills, and uploading May's must
 * not write "no entry" over April's. A status uploaded on its own answers
 * for every GRN on file of the units it covers, as it always has.
 *
 * A GRN this upload carries is stored over the copy on file (storePhBatch), so
 * that copy is left out: the upload's own row is the GRN.
 *
 * `db` is what runs the query -- the pool, or one connection for a check.
 */
export async function grnMatchKeys(grnRows, branches, db = { query }) {
  const mine = grnRows.map(grnForBpad);
  const carried = new Set(mine.filter((g) => g.grnNoKey).map((g) => `${g.grnNoKey}|${g.unitKey}`));

  // The units a status already answers for, before this upload -- so the
  // answer can tell an earlier GRN that is left as it was from one this upload
  // is the first to hold (unlistedNewlyHeldCount in matchBpadFiles).
  const { rows: covered } = await db.query(`SELECT DISTINCT unit_key FROM ph_bpad_records WHERE unit_key <> ''`);
  const unitsWithStatus = new Set(covered.map((row) => row.unit_key));

  const { rows } = await db.query(
    `SELECT DISTINCT ON (vendor_code, dpr_no_key, unit_key)
            vendor_code, vendor_name, dpr_no, dpr_no_key, dpr_date,
            total_amount, po_no, bill_no, bill_date, location, unit_key
     FROM ph_grn_transactions
     WHERE vendor_code IS NOT NULL AND vendor_code <> '' AND dpr_no_key <> ''
     ORDER BY vendor_code, dpr_no_key, unit_key, batch_id DESC, id DESC`,
  );
  const onFile = rows
    .filter((row) => !carried.has(`${row.dpr_no_key}|${row.unit_key}`))
    .map((row) => ({
      vendorCode: row.vendor_code,
      vendorName: row.vendor_name,
      grnNo: row.dpr_no,
      grnNoKey: row.dpr_no_key,
      grnDate: row.dpr_date,
      grnAmount: row.total_amount,
      poNumber: row.po_no,
      invNo: row.bill_no,
      invDate: row.bill_date,
      unitName: row.location,
      unitKey: row.unit_key,
      // Beside a GRN report: on hand to take a row the status lists for it,
      // and given no "no entry" row where the status lists none.
      listedOnly: mine.length > 0,
      // Whether any BPAD row was on file for this GRN's unit before this upload.
      unitHadStatus: unitsWithStatus.has(row.unit_key),
    }));
  // The upload's own first: within a unit the first writer wins.
  return indexGrnsForBpad([...mine, ...onFile], branches);
}

/**
 * Every configured pharmacy branch, as the matching reads it. Every branch,
 * ticked or not -- the tick scopes what is shown, not what a branch is called.
 */
async function configuredBranches() {
  const { rows } = await query('SELECT branch_code, location, bpad_location FROM ph_branch_configs');
  return rows.map(toBranch);
}

/**
 * POST /api/op-pharmacy/batches - upload one or more of the four pharmacy
 * files, store them, and reconcile what they touched.
 *
 * As POST /api/batches: each slot takes several files, the GRN reports, ageing
 * reports and BPAD statuses are each merged into one set of rows and stored as
 * one batch, and every bank statement after the first is a batch of its own.
 * Every file is read before anything is stored.
 */
phBatchesRouter.post(
  '/',
  requireScreen('upload'),
  refuseOversizedUpload,
  upload.fields([
    { name: 'grnFile', maxCount: MAX_FILES_PER_SLOT },
    { name: 'ageingFile', maxCount: MAX_FILES_PER_SLOT },
    { name: 'bankFile', maxCount: MAX_FILES_PER_SLOT },
    { name: 'bpadFile', maxCount: MAX_BPAD_FILES },
  ]),
  asyncHandler(async (req, res) => {
    const grnFiles = req.files?.grnFile ?? [];
    const ageingFiles = req.files?.ageingFile ?? [];
    const bankFiles = req.files?.bankFile ?? [];
    const bpadFiles = req.files?.bpadFile ?? [];
    const allFiles = [...grnFiles, ...ageingFiles, ...bankFiles, ...bpadFiles];

    if (allFiles.length === 0) {
      return res.status(400).json({
        error:
          'Choose at least one file: the GRN Purchase report, the Vendor Age report, the bank statement, or the BPAD current bill status.',
      });
    }

    // The backstop for a request that declared no length -- see
    // refuseOversizedUpload.
    const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > config.maxUploadTotalBytes) {
      return res.status(413).json({ error: tooLargeMessage(totalBytes) });
    }

    const name = String(req.body.name || '').trim() || defaultBatchName(allFiles);

    const grns = readEach(grnFiles, 'GRN Purchase report', readPhGrnReport);
    const ageings = readEach(ageingFiles, 'Vendor Age report', readPhAgeingReport);
    const banks = readEach(bankFiles, 'Bank statement', readBankStatement);

    // One row per GRN -- per number and unit -- as the upload will store them.
    const grnRows = lastRowPerUnitGrn(grns.flatMap((g) => g.rows));
    // Where two files carry one GRN, the later file's rows are kept -- "one
    // GRN" being its number under one division, as the upload stores and
    // replaces it (see storePhBatch). Two divisions' documents that share a
    // number are two GRNs' rows, and both are kept.
    const ageingRows = lastFilePerKey(
      ageings.map((a) => a.rows),
      (r) => (r.grnNumberKey ? `${r.grnNumberKey}|${r.divisionKey ?? normKey(r.divisionCode)}` : null),
    );

    // What Ph-Configuration holds, which is what ties the three reports to one
    // another -- see "The branch, and what goes through it" above.
    const branches = await configuredBranches();

    // The ageing report's DivisionCode has to be a configured branch's. A
    // report where none is can match nothing, and is refused before anything
    // is stored; where some are not, those rows are counted for the answer.
    const divisions = checkAgeingDivisions(ageingRows, branches);
    if (divisions.error) return res.status(400).json({ error: divisions.error });
    const ageingUnconfigured = divisions.unconfigured;

    // This upload's GRNs whose Unit Name no branch is configured for: stored,
    // and left pending until one is.
    const grnUnconfigured = unconfiguredGrnUnits(grnRows, branches);

    // Read last, and narrowed as it is read -- against this upload's own GRN
    // rows and every other pharmacy GRN on file (grnMatchKeys says why every
    // one). See matchBpadFiles for what makes a row a GRN's.
    let bpads = [];
    let bpadRows = [];
    // The status's rows that were kept, and the GRNs it had no entry for.
    let bpadMatchedCount = 0;
    let bpadNoEntryCount = 0;
    // Status rows that named one of these GRNs under another unit's Location.
    let bpadOtherBranchCount = 0;
    // GRNs whose Unit Name Ph-Configuration has no Location (BPAD) for, and
    // the status rows about them that were therefore not considered.
    let bpadUnconfigured = { grnCount: 0, rowCount: 0, units: [] };
    // GRNs of configured units whose Location the status never writes: not
    // answered for, so nothing was stored or replaced for them either.
    let bpadNotCovered = { grnCount: 0, units: [] };
    // GRNs from earlier reports that the status, uploaded beside a GRN
    // report, does not list: left as they were.
    let bpadUnlistedCount = 0;
    // And the ones of those that this upload is the first to hold: their unit
    // had no status on file, and has one now.
    let bpadUnlistedNewlyHeldCount = 0;
    if (bpadFiles.length > 0) {
      const identities = await grnMatchKeys(grnRows, branches);
      const matched = matchBpadFiles(bpadFiles, identities, branches);
      if (matched.error) return res.status(400).json({ error: matched.error });
      bpads = matched.bpads;
      bpadRows = matched.rows;
      bpadMatchedCount = matched.matchedCount;
      bpadNoEntryCount = matched.noEntryCount;
      bpadUnlistedCount = matched.unlistedCount;
      bpadUnlistedNewlyHeldCount = matched.unlistedNewlyHeldCount;
      bpadOtherBranchCount = matched.otherBranchCount;
      bpadUnconfigured = matched.unconfigured;
      bpadNotCovered = matched.notCovered;
    }

    const [firstBank, ...laterBanks] = banks;
    const main = await savePhBatch({
      name,
      grnFileName: fileNames(grnFiles),
      ageingFileName: fileNames(ageingFiles),
      userId: req.user.id,
      grnRows,
      ageingRows,
      bankFileName: bankFiles[0]?.originalname ?? null,
      bankRows: firstBank?.rows ?? [],
      bankAccountNo: firstBank?.accountNo ?? null,
      bpadFileName: fileNames(bpadFiles),
      bpadRows,
      bpadScanned: bpads.reduce((sum, b) => sum + b.scanned, 0),
    });

    // Every further statement in a batch of its own, since a batch holds one
    // account.
    const batchIds = [main.batchId];
    let replacedBankRows = main.replaced.bankRows;
    for (const [i, bank] of laterBanks.entries()) {
      const file = bankFiles[i + 1];
      const extra = await savePhBatch({
        name: defaultBatchName([file]),
        userId: req.user.id,
        bankFileName: file.originalname,
        bankRows: bank.rows,
        bankAccountNo: bank.accountNo ?? null,
      });
      batchIds.push(extra.batchId);
      replacedBankRows += extra.replaced.bankRows;
    }

    const { batchId, linked, unpaired, reopenedRejections } = main;
    const replaced = { ...main.replaced, bankRows: replacedBankRows };
    const bankRowCount = banks.reduce((sum, b) => sum + b.rows.length, 0);
    // One per statement, in the order uploaded; null where a letterhead named
    // no account.
    const bankAccountNos = banks.map((b) => b.accountNo ?? null);

    const files = allFiles.map((f) => f.originalname);
    logActivity(req, {
      action: 'PH_UPLOAD',
      target: name,
      summary: `Uploaded ${files.length} pharmacy file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`,
      details: {
        batchId,
        batchIds,
        grnFile: fileNames(grnFiles),
        grnRows: grnRows.length,
        ageingFile: fileNames(ageingFiles),
        ageingRows: ageingRows.length,
        bankFile: fileNames(bankFiles),
        bankRows: bankRowCount,
        bpadFile: fileNames(bpadFiles),
        bpadStoredRows: bpadRows.length,
        bpadOtherBranchRows: bpadOtherBranchCount,
        bpadUnconfiguredGrns: bpadUnconfigured.grnCount,
        bpadUnconfiguredRows: bpadUnconfigured.rowCount,
        bpadUnconfiguredUnits: bpadUnconfigured.units.map((u) => u.name),
        bpadNotCoveredGrns: bpadNotCovered.grnCount,
        bpadNotCoveredUnits: bpadNotCovered.units.map((u) => u.name),
        bpadUnlistedGrns: bpadUnlistedCount,
        bpadUnlistedNewlyHeldGrns: bpadUnlistedNewlyHeldCount,
        ageingUnconfiguredRows: ageingUnconfigured.rowCount,
        ageingUnconfiguredDivisions: ageingUnconfigured.divisions.map((d) => d.name),
        grnUnconfiguredGrns: grnUnconfigured.grnCount,
        grnUnconfiguredUnits: grnUnconfigured.units.map((u) => u.name),
        linked,
        unpaired,
        reopenedRejections,
        replaced,
      },
    });

    return res.status(201).json({
      batchId,
      batchIds,
      name,
      grnRowCount: grnRows.length,
      ageingRowCount: ageingRows.length,
      // How the GRNs this upload touched came out, counted from the results as
      // stored: in accounts, in accounts under a different bill number, or
      // pending. Either report can touch a GRN -- see storePhBatch.
      linked,
      // Of the pending ones, the GRNs that do have a Vendor Age row and are
      // pending only because no branch pairs its DivisionCode with their Unit
      // Name -- how many, and which pairs. See unpairedFor in phIngest.js.
      unpaired,
      // How many GRNs this upload took back off the CSD queue by carrying a
      // bill CSD had rejected -- see reopenRejectedFor in phIngest.js.
      reopenedRejections,
      bankRowCount,
      bankStatementCount: banks.length,
      bankAccountNo: firstBank?.accountNo ?? null,
      bankAccountNos,
      // How big the statuses were; how many of their rows were kept, counted
      // once per GRN however many files named it; how many GRNs the status had
      // no entry for; and the two together, which is what was stored.
      bpadRowCount: bpads.reduce((sum, b) => sum + b.scanned, 0),
      bpadMatchedCount,
      bpadNoEntryCount,
      bpadStoredCount: bpadRows.length,
      // Status rows that named one of these GRNs under a Location that is not
      // its unit's.
      bpadOtherBranchCount,
      // GRNs the status could not be matched for, because Ph-Configuration has
      // no Location (BPAD) for their Unit Name -- how many, which units, and
      // how many status rows about them were passed over. Nothing was stored
      // or replaced for these GRNs.
      bpadUnconfiguredGrnCount: bpadUnconfigured.grnCount,
      bpadUnconfiguredRowCount: bpadUnconfigured.rowCount,
      bpadUnconfiguredUnits: bpadUnconfigured.units.map((u) => u.name),
      // GRNs of configured units whose Location the status never writes -- a
      // status exported for other units. Nothing was stored or replaced for
      // these GRNs either.
      bpadNotCoveredGrnCount: bpadNotCovered.grnCount,
      bpadNotCoveredUnits: bpadNotCovered.units.map((u) => u.name),
      // GRNs from earlier uploads, of units the status does cover, that it
      // does not list -- it came beside a GRN report, so it answers "no entry"
      // for that report's GRNs only. Left as they were. See grnMatchKeys.
      bpadUnlistedGrnCount: bpadUnlistedCount,
      // The others it does not list, of a unit that had no status on file
      // until this upload: nothing is stored for them, but BPAD is matched
      // first for their unit from now on, so they read as pending at the GRN
      // store.
      bpadUnlistedNewlyHeldGrnCount: bpadUnlistedNewlyHeldCount,
      // Vendor Age rows whose DivisionCode is no configured branch's Branch
      // code (Focus), and which codes: stored, and matched to no GRN until a
      // branch is configured for them.
      ageingUnconfiguredRowCount: ageingUnconfigured.rowCount,
      ageingUnconfiguredDivisions: ageingUnconfigured.divisions.map((d) => d.name),
      // This upload's GRNs whose Unit Name is no configured branch's Unit name
      // (HIS), and which units: stored, and pending until one is.
      grnUnconfiguredCount: grnUnconfigured.grnCount,
      grnUnconfiguredUnits: grnUnconfigured.units.map((u) => u.name),
      replaced,
    });
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phBatchesRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
