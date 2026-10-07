/**
 * Create the schema and seed the admin account.
 * Idempotent: safe to run as many times as you like.
 *
 *   npm run migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { pool, query, withTransaction } from './pool.js';
import { backfillVendorMaster } from '../services/vendorMaster.js';
import { relinkStoredResults } from '../services/ingest.js';
import { relinkPhResults } from '../services/phIngest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  console.log('Schema is up to date.');

  // Each result against the ageing row its GRN pairs with now -- after
  // schema.sql has cleared the older copies away. Not SQL in schema.sql: the
  // verdict for a pair is reconcile.js's rule (matchGrnAgeingPair), and it
  // should be worked out in one place.
  const relinked = await relinkStoredResults();
  if (relinked > 0) console.log(`Reconciliation: re-linked ${relinked} result(s) to their GRN's ageing row.`);

  // The same for OP Pharmacy, whose rule for which ageing row is a GRN's goes
  // through Ph-Configuration: results stored before that rule existed, or
  // under an earlier form of it, are brought in line with the branches as
  // they stand. Touches only the ph_ tables, and changes nothing once every
  // result is in line.
  const ph = await withTransaction((client) => relinkPhResults(client));
  if (ph.changed > 0) console.log(`OP Pharmacy: re-matched ${ph.changed} result(s) to Ph-Configuration.`);

  // The reco runs not yet applied to the Vendor Master -- on the first run,
  // every one stored before it existed. Not SQL in schema.sql: the vendor code
  // has to be matched exactly as an upload matches it, and that rule lives in
  // JavaScript (codeKey).
  const { applied, msmeNumbers } = await backfillVendorMaster();
  if (applied > 0) console.log(`Vendor Master: applied ${applied} earlier reco run(s).`);
  if (msmeNumbers > 0) console.log(`Vendor Master: filled in the MSME number of ${msmeNumbers} vendor(s).`);

  const { username, password, fullName } = config.seedAdmin;
  const passwordHash = await bcrypt.hash(password, 10);

  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'ADMIN')
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [username, passwordHash, fullName],
  );

  if (rows.length > 0) {
    console.log(`Seeded admin user "${username}".`);
  } else {
    console.log(`Admin user "${username}" already exists - left unchanged.`);
  }
}

migrate()
  .then(() => pool.end())
  .then(() => {
    console.log('Migration complete.');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nMigration failed:', err.message);
    if (err.code === 'ECONNREFUSED' || err.code === '3D000') {
      console.error(
        '\nCheck that PostgreSQL is running and that DATABASE_URL in server/.env is correct,\n' +
          'and that the database exists:  CREATE DATABASE yh_grn;\n',
      );
    }
    await pool.end().catch(() => {});
    process.exit(1);
  });
