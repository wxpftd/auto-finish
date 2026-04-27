// pm2 ecosystem for local dev. Brings up orchestrator + dashboard.
// docker (opensandbox-server) is managed separately by `docker compose`.
//
//   pnpm dev          start both
//   pnpm dev:logs     tail interleaved logs
//   pnpm dev:status   show process table
//   pnpm dev:stop     stop both (keep in pm2 list)
//   pnpm dev:down     stop + remove from pm2 (full cleanup)

const path = require('node:path');

const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'orchestrator',
      cwd: path.join(ROOT, 'apps/orchestrator'),
      // tsx watch handles its own reload on .ts changes; pm2 just supervises.
      script: './node_modules/.bin/tsx',
      args: 'watch src/server.ts',
      env: {
        PORT: '4000',
        DB_PATH: path.join(ROOT, '.auto-finish/orchestrator.sqlite'),
        // SDK runs on the host but opensandbox-server lives in docker — bridge-mode
        // endpoint URLs the server hands back aren't reachable from the host.
        // Routing execd traffic through the server proxy fixes this. See
        // src/sandbox/opensandbox-provider.ts:60-70.
        OPENSANDBOX_USE_SERVER_PROXY: '1',
      },
      // tsx owns the watch; let pm2 only restart on crash.
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '5s',
      kill_timeout: 5000,
      // The .bin/* entries are POSIX shell wrappers, not Node modules.
      // Default pm2 interpreter (node) chokes parsing them — let the OS exec.
      interpreter: 'none',
    },
    {
      name: 'dashboard',
      cwd: path.join(ROOT, 'apps/dashboard'),
      script: './node_modules/.bin/vite',
      args: 'dev',
      // PUBLIC_API_BASE_URL / PUBLIC_WS_BASE_URL come from
      // apps/dashboard/.env.local (vite reads dotenv automatically).
      env: {},
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '5s',
      kill_timeout: 5000,
      // The .bin/* entries are POSIX shell wrappers, not Node modules.
      // Default pm2 interpreter (node) chokes parsing them — let the OS exec.
      interpreter: 'none',
    },
  ],
};
