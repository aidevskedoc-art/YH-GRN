import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { pool } from './db/pool.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { batchesRouter } from './routes/batches.js';
import { resultsRouter, ageingRouter, recordsRouter, accountsReturnsRouter } from './routes/results.js';
import { csdRouter } from './routes/csd.js';
import { configRouter } from './routes/config.js';
import { logsRouter } from './routes/logs.js';
import { msmeRecoRouter } from './routes/msmeReco.js';
import { vendorMasterRouter } from './routes/vendorMaster.js';
import { purgeOldLogs } from './services/activityLog.js';
import { applyPendingVendorMasters } from './services/vendorMaster.js';
import { errorHandler } from './middleware/error.js';

const app = express();

app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'unreachable', error: err.message });
  }
});

app.use('/api/auth', authRouter);
// Accounts and screen access. Administrator-only, enforced inside the router.
app.use('/api/users', usersRouter);
// resultsRouter is mounted first: its paths are more specific (/:id/summary,
// /:id/results, /:id/export) and must not be shadowed by batchesRouter.
app.use('/api/batches', resultsRouter);
// Correcting a stage date writes to one ageing row, which no batch owns
// exclusively -- the same row is read by whichever uploads are in scope.
app.use('/api/ageing', ageingRouter);
// The CSD queue is its own resource: a handover outlives the upload it was read
// from, so it hangs off neither a batch nor an ageing row.
app.use('/api/csd', csdRouter);
// Branch definitions, and which of them are in scope. Reading is open to any
// signed-in account; writing needs the Configuration screen.
app.use('/api/config', configRouter);
// The other destination on a Valid GRNs row. One route, no screen of its own --
// see the Records section at the foot of routes/results.js.
app.use('/api/records', recordsRouter);
// GRNs CSD has handed back to Accounts. Its own resource for the same reason
// the CSD queue is: it outlives the batch and the CSD dispatch it started
// from -- see the section at the foot of routes/results.js.
app.use('/api/accounts-returns', accountsReturnsRouter);
app.use('/api/batches', batchesRouter);
// Who did what, for the Activity logs screen. Administrator-only, enforced
// inside the router.
app.use('/api/logs', logsRouter);
// The HIS vendor master against the Accounts vendor list. Its own resource:
// it reads neither GRN report and belongs to no batch.
app.use('/api/msme-reco', msmeRecoRouter);
// Every HIS vendor with its latest details. Read-only: each reco run above
// adds its new vendors and updates the rest.
app.use('/api/vendor-master', vendorMasterRouter);

// Serve the built client if it exists, so `npm start` alone runs the whole app.
const clientDist = path.join(config.rootDir, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (${config.nodeEnv})`);
  if (!fs.existsSync(clientDist)) {
    console.log(`Client dev server expected at ${config.clientOrigin}`);
  }
});

// The activity log keeps 90 days: trimmed once at startup, then daily. unref so
// the timer never holds the process open on shutdown.
const DAY_MS = 24 * 60 * 60 * 1000;
purgeOldLogs();
setInterval(purgeOldLogs, DAY_MS).unref();

// A reco stored without reaching the Vendor Master -- by a server still running
// older code after the migration -- is applied now rather than at the next
// reco. Never fatal: the screens work without it.
applyPendingVendorMasters()
  .then((applied) => {
    if (applied > 0) console.log(`Vendor Master: applied ${applied} earlier reco run(s).`);
  })
  .catch((err) => console.error('Vendor Master: could not apply earlier reco runs:', err.message));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}
