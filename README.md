# Side by Side

Side by Side is a real-time collaborative workspace. Create a room, copy its invite link, and open it in two browsers to edit the same document. The sidebar shows connected collaborators. Use **Export text** to keep a portable copy.

## Run locally

```sh
npm ci
npm run build
npm start
```

Open `http://localhost:3000`. Requires Node.js 22.13 or later. Run `npm test` for HTTP and WebSocket integration tests, and `npm run bench` for the reproducible benchmark in [RESULTS.md](RESULTS.md).

## Architecture

Yjs merges concurrent plain-text edits. Each browser saves a local copy in IndexedDB and exchanges binary updates over WebSocket. On reconnect, the server sends a snapshot and the browser submits its delta. The server validates updates and serializes writes per room. It persists a validated snapshot before acknowledging and broadcasting an edit. Presence is transient. Production uses a separate Postgres database, while SQLite provides local persistence without an external service.

Invite links are bearer capabilities with 144 bits of randomness. Anyone with a link can edit. The URL fragment stays out of ordinary page requests, and the WebSocket endpoint requires the room identifier and matching origin. The demo limits room creation, updates, document size, and client count. It uses one process by design. Horizontal replication would require coordinated writes and cross-instance fan-out. Avoid confidential documents in the public demo.

## Deploy

Use one Render Node web service with `npm ci && npm run build` and `npm start`. Run in the same region as Postgres and set `DATABASE_URL` to its internal URL as a secret. Render provides `PORT` and `RENDER_EXTERNAL_URL`. Elsewhere, set `PUBLIC_ORIGIN` to the public HTTPS origin. The free Render web service can cold-start after inactivity, and its free database expires after 30 days. Export work before the demo database expires.
