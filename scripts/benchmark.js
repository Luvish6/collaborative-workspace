import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { createWorkspace } from "../src/server.js";
import { openStore } from "../src/store.js";
import { joinRoom, makeRoom } from "./socket-client.js";

const folder = await mkdtemp(join(tmpdir(), "workspace-bench-"));
const store = await openStore({ file: join(folder, "bench.sqlite") });
const app = await createWorkspace({ store });
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const base = "http://127.0.0.1:" + app.server.address().port;

function percentile(values, p) {
  return [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
}

try {
  for (const size of [2, 8, 16]) {
    const id = await makeRoom(base);
    const clients = Array.from({ length: size }, () => joinRoom(base, id));
    await Promise.all(clients.map(client => client.ready()));
    const deliveries = [];
    const start = performance.now();
    // Twenty waves spaced across 2 seconds, below the per-connection message cap.
    for (let wave = 0; wave < 20; wave++) {
      const marks = clients.map((_, index) => "[" + wave + ":" + index + "]");
      await Promise.all(clients.map(async (client, index) => {
        const mark = marks[index];
        const vector = Y.encodeStateVector(client.doc);
        client.text.insert(client.text.length, mark);
        const sent = performance.now();
        await Promise.all([
          client.send(Y.encodeStateAsUpdate(client.doc, vector)),
          ...clients.filter(other => other !== client).map(other => other.wait(() => other.text.toString().includes(mark)))
        ]);
        deliveries.push(performance.now() - sent);
      }));
      const delay = start + (wave + 1) * 100 - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    for (const client of clients) assert.equal(client.text.toString(), clients[0].text.toString());
    console.log(JSON.stringify({
      clients: size, edits: deliveries.length,
      deliveredPerSecond: deliveries.length / ((performance.now() - start) / 1000),
      p50Ms: percentile(deliveries, .5), p95Ms: percentile(deliveries, .95)
    }));
    for (const client of clients) client.socket.close();
  }
} finally {
  await app.close();
  await rm(folder, { recursive: true, force: true });
}
