import pg from 'pg';
import { config } from '../config/env.js';

// Return NUMERIC as a JS number rather than a string. Amounts here are bill
// values well inside the safe-integer range, and the API serializes them as
// numbers for the UI.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));

// Return DATE as a plain yyyy-MM-dd string, not a Date shifted by the server's
// timezone, which would move dates across a day boundary.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, rolling back on any error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
