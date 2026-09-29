import multer from 'multer';
import { config } from '../config/env.js';

/** Wrap an async route handler so rejections reach the error handler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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
