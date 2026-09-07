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
import { pool, query } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  console.log('Schema is up to date.');

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
