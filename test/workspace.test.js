import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { createWorkspace } from "../src/server.js";
import { openStore } from "../src/store.js";
import { joinRoom, makeRoom } from "../scripts/socket-client.js";

async function start(file = ":memory:", createLimit) {
  const store = await openStore({ file });
  const app = await createWorkspace({ store, createLimit });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  return { ...app, base: "http://127.0.0.1:" + app.server.address().port };
}

test("room creation validates Origin, limits requests and serves health", async () => {
  const app = await start(":memory:", 1);
  try {
    assert.equal((await fetch(app.base + "/health")).status, 200);
    assert.equal((await fetch(app.base + "/api/rooms", { method: "POST" })).status, 403);
    assert.match(await makeRoom(app.base), /^[\w-]{24}$/);
    await assert.rejects(makeRoom(app.base), /429/);
  } finally { await app.close(); }
});

test("rooms isolate state, enforce capability and reject cross-origin sockets", async () => {
  const app = await start();
  try {
    const id = await makeRoom(app.base);
    const other = await makeRoom(app.base);
    const writer = joinRoom(app.base, id);
    const isolated = joinRoom(app.base, other);
    await Promise.all([writer.ready(), isolated.ready()]);
    await assert.rejects(joinRoom(app.base, "z".repeat(24)).ready(), /404/);
    await assert.rejects(joinRoom(app.base, id, undefined, "https://unrelated.example").ready(), /403/);
    writer.text.insert(0, "private room text");
    await writer.send(Y.encodeStateAsUpdate(writer.doc));
    assert.equal(isolated.text.toString(), "");
  } finally { await app.close(); }
});

test("concurrent edits converge and presence tracks live collaborators", async () => {
  const app = await start();
  try {
    const id = await makeRoom(app.base);
    const a = joinRoom(app.base, id);
    const b = joinRoom(app.base, id);
    await Promise.all([a.ready(), b.ready()]);
    a.socket.send("Sam");
    b.socket.send("Priya");
    await a.wait(() => a.presence().includes("Priya"));
    a.text.insert(0, "alpha");
    b.text.insert(0, "beta");
    await Promise.all([a.send(Y.encodeStateAsUpdate(a.doc)), b.send(Y.encodeStateAsUpdate(b.doc))]);
    await Promise.all([a.wait(() => a.text.length === 9), b.wait(() => b.text.length === 9)]);
    assert.equal(a.text.toString(), b.text.toString());
    b.socket.close();
    await a.wait(() => a.presence().length === 1);
  } finally { await app.close(); }
});

test("reconnect merges offline changes and committed state survives restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "workspace-test-"));
  const file = join(folder, "test.sqlite");
  let app = await start(file);
  try {
    const id = await makeRoom(app.base);
    const a = joinRoom(app.base, id);
    const b = joinRoom(app.base, id);
    await Promise.all([a.ready(), b.ready()]);
    const disconnected = once(b.socket, "close");
    b.socket.close();
    await disconnected;
    const vector = Y.encodeStateVector(b.doc);
    b.text.insert(0, "offline");
    a.text.insert(0, "online");
    await a.send(Y.encodeStateAsUpdate(a.doc));
    const resumed = joinRoom(app.base, id, b.doc);
    await resumed.ready();
    await resumed.send(Y.encodeStateAsUpdate(resumed.doc, vector));
    await a.wait(() => a.text.length === 13);
    const saved = a.text.toString();
    await app.close();
    app = await start(file);
    const restored = joinRoom(app.base, id);
    await restored.ready();
    assert.equal(restored.text.toString(), saved);
    assert.match(saved, /offline/);
    assert.match(saved, /online/);
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("empty sync is acknowledged and invalid updates leave the document intact", async () => {
  const app = await start();
  try {
    const id = await makeRoom(app.base);
    const a = joinRoom(app.base, id);
    await a.ready();
    await a.send(Y.encodeStateAsUpdate(a.doc));
    const close = once(a.socket, "close");
    a.socket.send(Buffer.from([255, 255, 255]));
    assert.equal((await close)[0], 1008);
    const b = joinRoom(app.base, id);
    await b.ready();
    assert.equal(b.text.toString(), "");
  } finally { await app.close(); }
});

test("document size limit rejects oversized merged text", async () => {
  const app = await start();
  try {
    const id = await makeRoom(app.base);
    const a = joinRoom(app.base, id);
    await a.ready();
    a.text.insert(0, "x".repeat(100001));
    const close = once(a.socket, "close");
    a.socket.send(Y.encodeStateAsUpdate(a.doc));
    assert.equal((await close)[0], 1009);
    const b = joinRoom(app.base, id);
    await b.ready();
    assert.equal(b.text.length, 0);
  } finally { await app.close(); }
});
