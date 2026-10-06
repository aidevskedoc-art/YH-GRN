import multer from 'multer';
import { config } from '../config/env.js';

/** Wrap an async route handler so rejections reach the error handler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * For a router whose tables a migration adds or changes: a query that finds
 * the database behind the code answers with what to do about it.
 *
 * Postgres reports a table that does not exist as 42P01 and a column that does
 * not as 42703, and the handler below would turn either into "Something went
 * wrong on the server" -- true, and no help to the one person who can fix it,
 * which is whoever updated the code and has not yet run the migration. `what`
 * names the tables in the message.
 *
 * Mounted at the end of the router it guards, after its routes.
 */
export function tablesNotMigrated(what) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  return (err, req, res, next) => {
    if (err?.code !== '42P01' && err?.code !== '42703') return next(err);
    console.error(err.message);
    return res.status(503).json({
      error: `${what} in the database are missing or out of date. Stop the server, run "npm run migrate" in the server folder, and start it again.`,
    });
  };
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    // The screens check sizes and counts before sending, so these are the net
    // under a stale page or a direct API call -- but still worded for a person.
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The limit is ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Too many files in one upload. Remove some and upload them in a second go.'
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? // Multer's one code for both a field sent more files than it
              // takes and a field it does not take at all.
              `Upload failed: too many files, or a file this upload does not take (sent as "${err.field}").`
            : `Upload failed: ${err.message}`;
    return res.status(400).json({ error: message });
  }

  const status = err.status || 500;

  if (status >= 500) {
    console.error(err);
  }

  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server.' : err.message,
  });
}
