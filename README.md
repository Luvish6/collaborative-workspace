# Side by Side

Side by Side is a real-time collaborative workspace. Create a room, copy its invite link, and open it in two browsers to edit the same document. The sidebar shows connected collaborators. Use **Export text** to keep a portable copy.

## Run locally

```sh
npm ci
npm run build
npm start
```

Open `http://localhost:3000`. Requires Node.js 22.13 or later. Run `npm test` for HTTP and WebSocket integration tests, and `npm run bench` for the reproducible benchmark in [RESULTS.md](RESULTS.md).

For browser regression coverage, run `npx playwright-core install chromium` once and then `npm run test:browser` after building. Set `BROWSER_EXE` to an installed Chromium or Edge binary to skip the download. The test opens separate browser contexts and verifies edits, presence, refresh, offline recovery, and database restart.

## Run locally with Neon

For local PostgreSQL testing, supply `DATABASE_URL` with a Neon TLS connection string and run `npm start`. If the URL is stored in a local environment file, run `node --env-file-if-exists=.env --env-file-if-exists=.env.local src/server.js`. Use a direct verified connection for backups and restores. Keep connection strings outside source control.

## Architecture

Yjs merges concurrent plain-text edits. Each browser saves a local copy in IndexedDB and exchanges binary updates over WebSocket. On reconnect, the server sends a snapshot and the browser submits its delta. The server validates updates and serializes writes per room. It persists a validated snapshot before acknowledging and broadcasting an edit. Presence is transient. Production uses a separate Postgres database, while SQLite provides local persistence without an external service.

Invite links are bearer capabilities with 144 bits of randomness. Anyone with a link can edit. The URL fragment stays out of ordinary page requests, and the WebSocket endpoint requires the room identifier and matching origin. The demo limits room creation, updates, document size, and client count. It uses one process by design. Horizontal replication would require coordinated writes and cross-instance fan-out. Avoid confidential documents in the public demo.

## Deploy

Use one Render Node web service with `npm ci && npm run build` and `npm start`. Set `DATABASE_URL` in the service's Environment settings to the Neon production connection with `sslmode=verify-full`. The Blueprint leaves this secret under dashboard management. Render supplies `PORT` and `RENDER_EXTERNAL_URL`. Elsewhere, set `PUBLIC_ORIGIN` to the public HTTPS origin. The free web service and Neon compute can cold-start after inactivity.

### Render-to-Neon cutover

Use the existing Render service and keep its source `DATABASE_URL` in place for the copy. Set `NEON_MIGRATION_URL` as a Render secret to a direct Neon URL with `sslmode=verify-full`. By default, startup makes a consistent, read-only source backup in Neon and continues serving Render Postgres. Verify the staged data and check both app connections before setting `NEON_MIGRATION_PHASE=cutover`. Cutover takes a source write lock, checks the schema, decodes each Yjs snapshot, and verifies matching counts and SHA-256 digests for the final backup and active Neon tables. It fences writes on the retained source before serving Neon. Clients can reconnect and submit local changes.

After verifying the migration and live collaboration, set `DATABASE_URL` to the verified Neon connection and remove `NEON_MIGRATION_URL` and `NEON_MIGRATION_PHASE` in the same configuration change. Restart and verify a document in a fresh browser session. The old Render database is intentionally retained and write-fenced. Delete it from its Render database dashboard only after verifying the new configuration and keeping a protected backup. Preserve any new Neon edits before rolling back to the retained source.
