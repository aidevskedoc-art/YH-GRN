/**
 * Environment loading and validation.
 *
 * The .env file lives in `server/`, next to the only thing that reads it. Every
 * variable in it is a server concern -- the database URL, the JWT secret, the
 * seed password -- and none of them belong in a browser bundle; the client
 * build deliberately does not read it (see client/vite.config.js). Keeping it
 * here means the API can be deployed or containerised on its own, without
 * reaching outside its own directory for its configuration.
 *
 * ROOT_DIR is still resolved: in production the server serves the built client
 * out of <root>/client/dist, so it needs to know where the root is.
 *
 * Required variables are checked at startup so a half-filled .env fails loudly
 * here rather than at the first query.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '../..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');

dotenv.config({ path: path.join(SERVER_DIR, '.env') });

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `\nMissing required environment variable(s): ${missing.join(', ')}\n` +
      `Copy server/.env.example to server/.env and fill in the values.\n`,
  );
  process.exit(1);
}

if (process.env.JWT_SECRET === 'change-me-to-a-long-random-string') {
  console.warn('WARNING: JWT_SECRET is still the placeholder value from .env.example. Change it before deploying.');
}

export const config = {
  rootDir: ROOT_DIR,
  port: Number(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  seedAdmin: {
    username: process.env.SEED_ADMIN_USERNAME || 'Admin',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
    fullName: process.env.SEED_ADMIN_NAME || 'Administrator',
  },
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
};
