import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// The API port only matters for the dev proxy; in production the built client
// is served by the API itself and uses same-origin /api paths.
//
// This deliberately does NOT read server/.env: that file holds server secrets
// (JWT_SECRET, DATABASE_URL, the seed password), which have no business in a
// client build. Override with VITE_API_PORT if the API is not on 4100.
const apiPort = process.env.VITE_API_PORT || '4100';

// ---------------------------------------------------------------------------
// A note on why this file is not the Vite default.
//
// esbuild works by spawning a long-lived esbuild.exe child process. On this
// machine that child is intermittently killed about a second after it starts --
// measured at roughly one spawn in six, exit code 1 with no output. Vite starts
// the service once per dev server, so a single killed spawn leaves every later
// request failing with "The service is no longer running" until the dev server
// is restarted, and a build dies with "The service was stopped: write EPIPE".
//
// Vite uses esbuild in several places and it cannot be removed outright (the
// vite:define plugin and dependency pre-bundling both need it). What this config
// does is take esbuild off the hot paths, so a run makes far fewer spawns and
// has far fewer chances to be hit:
//
//   JSX        -> SWC, a native module loaded in-process (plugin-react-swc).
//                 The stock plugin-react delegates JSX to esbuild per file.
//   minify     -> terser, pure JS.
//   cssMinify  -> lightningcss, an in-process native module.
//   target     -> 'esnext' makes Vite skip its esbuild chunk-transpile pass.
//
// This is mitigation, not a cure. The real fix is an endpoint-protection
// exclusion for this folder -- see the troubleshooting section in README.md.
// ---------------------------------------------------------------------------

export default defineConfig({
  plugins: [react()],

  // Every bare import the app makes, declared up front.
  //
  // Vite pre-bundles dependencies with esbuild. Left to itself it discovers
  // them by crawling from the entry, and a bare import it has not seen before
  // triggers a RE-optimisation in the middle of the session -- a second esbuild
  // spawn, and a second chance for it to be killed. That failure reads
  // "error while updating dependencies: The service is no longer running",
  // which is the same underlying problem as the one in the header above but
  // reached down a different path.
  //
  // Two things were discovered late in practice: `react-dom` (imported bare for
  // createPortal, where main.jsx imports only `react-dom/client`) and `exceljs`,
  // which is a lazy dynamic import and so is not reached until the first Export.
  // Naming them here folds both into the single optimiser run at startup.
  //
  // This is a dev-server concern only. The production build's code splitting is
  // decided by rollup, so exceljs is still emitted as its own lazy chunk.
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'exceljs'],
  },

  server: {
    port: 5173,
    // Listen on every interface, not just loopback, so the dev server is
    // reachable from other machines on the network as well as from this one.
    //
    // Vite has no HOST environment variable -- that is a Create React App
    // convention, and setting it here does nothing. The equivalents are this
    // option and the `--host` flag; VITE_DEV_HOST narrows it to one address if
    // binding everything is not wanted.
    host: process.env.VITE_DEV_HOST || true,
    proxy: {
      // Requests go to /api/... in dev and are proxied to the API server, so
      // the client needs no base-URL configuration of its own.
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    cssMinify: 'lightningcss',
    // 'esnext' emits the syntax as authored, which every browser this runs on
    // (current Chrome/Edge) supports natively.
    target: 'esnext',
    // ExcelJS is ~930 kB and deliberately split into its own lazily-fetched
    // chunk, so it trips the stock 500 kB warning on every build. Raising the
    // limit keeps the warning meaningful: it should fire for a real regression,
    // not for a decision already made.
    chunkSizeWarningLimit: 1000,
  },
});
