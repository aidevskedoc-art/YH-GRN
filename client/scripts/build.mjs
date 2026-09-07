/**
 * Runs `vite build`, retrying if esbuild's child process is killed mid-build.
 *
 * Vite needs esbuild in a few places that cannot be configured away (the
 * vite:define plugin, dependency pre-bundling). On this machine that child is
 * intermittently killed shortly after it spawns, which surfaces as
 * "The service was stopped" / "The service is no longer running" / EPIPE.
 * The failure is transient, so simply running the build again clears it.
 *
 * Only that specific failure is retried. A genuine compile error fails on the
 * first attempt, as it should.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const MAX_ATTEMPTS = 3;

// Resolve Vite's own JS entry and run it with this Node binary. Spawning the
// `vite` shim through a shell instead would need `shell: true`, which Node now
// warns about because the arguments are concatenated rather than escaped.
//
// The path is derived from package.json's own `bin` field rather than resolved
// directly: vite's `exports` map does not expose bin/vite.js, so asking for it
// by path throws ERR_PACKAGE_PATH_NOT_EXPORTED.
const require = createRequire(import.meta.url);
const vitePkgPath = require.resolve('vite/package.json');
const vitePkg = require('vite/package.json');
const binRelative = typeof vitePkg.bin === 'string' ? vitePkg.bin : vitePkg.bin.vite;
const VITE_BIN = path.resolve(path.dirname(vitePkgPath), binRelative);

const TRANSIENT = [
  'The service was stopped',
  'The service is no longer running',
  'write EPIPE',
];

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITE_BIN, 'build', ...process.argv.slice(2)], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }

    child.on('exit', (code) => resolve({ code, output }));
  });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  // eslint-disable-next-line no-await-in-loop
  const { code, output } = await runBuild();

  if (code === 0) process.exit(0);

  const transient = TRANSIENT.some((marker) => output.includes(marker));
  if (!transient) {
    console.error('\nBuild failed. This is a real error, not the esbuild flake - not retrying.');
    process.exit(code ?? 1);
  }

  if (attempt < MAX_ATTEMPTS) {
    console.error(`\nesbuild's helper process died (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying...\n`);
  } else {
    console.error(`\nesbuild's helper process died on all ${MAX_ATTEMPTS} attempts.`);
    console.error('See the troubleshooting section in README.md.');
    process.exit(code ?? 1);
  }
}
