import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import { openStore } from "./store.js";

const publicRoot = new URL("../public/", import.meta.url);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
]);
const roomPattern = /^[A-Za-z0-9_-]{24}$/;
const maxSnapshot = 512 * 1024;
const maxText = 100000;
const maxClients = 32;
const headers = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store"
};

function reply(response, status, value) {
  response.writeHead(status, { ...headers, "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function packet(type, bytes) {
  return Buffer.concat([Buffer.from([type]), bytes]);
}

export async function createWorkspace({ store, origin, createLimit = 12 }) {
  const rooms = new Map();
  const creation = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxSnapshot + 1 });
  const heartbeat = setInterval(() => {
    creation.clear();
    for (const socket of wss.clients) {
      if (!socket.alive) socket.terminate();
      else {
        socket.alive = false;
        socket.ping();
      }
    }
  }, 30000);
  heartbeat.unref();

  function allowedOrigin(request) {
    return request.headers.origin === (origin || "http://" + request.headers.host);
  }

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (request.method === "GET" && path === "/health") {
        await store.get("health");
        return reply(response, 200, { status: "ok" });
      }
      if (request.method === "POST" && path === "/api/rooms") {
        if (!allowedOrigin(request)) return reply(response, 403, { error: "Origin not allowed." });
        const key = request.socket.remoteAddress;
        const now = (creation.get(key) || 0) + 1;
        if (now > createLimit) return reply(response, 429, { error: "Too many rooms created. Try again shortly." });
        creation.set(key, now);
        const id = randomBytes(18).toString("base64url");
        const doc = new Y.Doc();
        try {
          await store.create(id, Y.encodeStateAsUpdate(doc));
        } finally {
          doc.destroy();
        }
        return reply(response, 201, { id });
      }
      const asset = (request.method === "GET" || request.method === "HEAD") && assets.get(path);
      if (!asset) return reply(response, 404, { error: "Not found." });
      const [file, type] = asset;
      const body = await readFile(new URL(file, publicRoot));
      response.writeHead(200, { ...headers, "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      console.error("Request failed:", error.message);
      reply(response, 503, { error: "Workspace temporarily unavailable." });
    }
  });

  function openRoom(id) {
    if (!rooms.has(id)) {
      const entry = { clients: new Set(), pending: 0, queue: Promise.resolve() };
      entry.loaded = Promise.resolve().then(() => store.get(id));
      rooms.set(id, entry);
    }
    return rooms.get(id);
  }

  function evict(id, room) {
    if (!room.clients.size && room.pending === 0) rooms.delete(id);
  }

  server.on("upgrade", async (request, socket, head) => {
    const path = request.url.match(/^\/live\/([A-Za-z0-9_-]+)$/);
    if (!path || !roomPattern.test(path[1]) || !allowedOrigin(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const id = path[1];
    const room = openRoom(id);
    room.pending++;
    try {
      const initial = await room.loaded;
      if (!initial || room.clients.size >= maxClients) {
        socket.end(initial ? "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n" :
          "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      room.snapshot ??= initial;
      wss.handleUpgrade(request, socket, head, client => connect(id, room, client));
    } catch {
      socket.destroy();
    } finally {
      room.pending--;
      evict(id, room);
    }
  });

  function send(socket, data) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * maxSnapshot) socket.close(1013, "Slow connection");
    else socket.send(data);
  }

  function broadcast(room, data, except) {
    for (const socket of room.clients) if (socket !== except) send(socket, data);
  }

  function presence(room) {
    broadcast(room, JSON.stringify({ people: [...room.clients].map(socket => socket.name) }));
  }

  function connect(id, room, socket) {
    socket.alive = true;
    socket.name = "Guest";
    let messages = 0;
    let windowStart = Date.now();
    room.clients.add(socket);
    socket.on("pong", () => { socket.alive = true; });
    socket.on("error", () => socket.terminate());
    socket.once("close", () => {
      room.clients.delete(socket);
      presence(room);
      evict(id, room);
    });
    send(socket, packet(0, room.snapshot));
    presence(room);
    socket.on("message", (data, binary) => {
      if (Date.now() - windowStart >= 1000) {
        windowStart = Date.now();
        messages = 0;
      }
      if (++messages > 30) return socket.close(1008, "Too many messages");
      if (!binary) {
        const name = data.length <= 120 ? data.toString().trim() : "";
        if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) return socket.close(1008, "Invalid name");
        socket.name = name;
        presence(room);
        return;
      }
      if (data.length < 2) return socket.close(1008, "Invalid update");
      if (room.pending >= 96) return socket.close(1013, "Room queue full");
      room.pending++;
      room.queue = room.queue.then(async () => {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, room.snapshot);
          Y.applyUpdate(doc, data);
          const fields = [...doc.share.keys()];
          const text = doc.getText("document");
          const title = doc.getText("title");
          const snapshot = Y.encodeStateAsUpdate(doc);
          if (fields.some(field => field !== "document" && field !== "title") ||
              text.length > maxText || title.length > 100 || snapshot.length > maxSnapshot ||
              /[\r\n]/.test(title.toString()) || [text, title].some(field =>
                field.toDelta().some(delta => typeof delta.insert !== "string" || delta.attributes))) {
            socket.close(1009, "Document limit exceeded");
            return;
          }
          try {
            if (!Buffer.from(snapshot).equals(Buffer.from(room.snapshot))) {
              await store.save(id, snapshot);
              room.snapshot = snapshot;
              broadcast(room, packet(1, data), socket);
            }
            send(socket, packet(2, Buffer.alloc(0)));
          } catch (error) {
            console.error("Save failed:", error.message);
            socket.close(1011, "Save failed; reconnect to retry");
          }
        } catch {
          socket.close(1008, "Invalid update");
        } finally {
          doc.destroy();
          room.pending--;
          evict(id, room);
        }
      });
    });
  }

  return {
    server,
    async close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      await Promise.all([...rooms.values()].map(room => room.queue));
      await store.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await Promise.all([...assets.values()].map(([file]) => readFile(new URL(file, publicRoot))));
  } catch (error) {
    throw new Error("Workspace assets missing. Run npm run build before npm start.", { cause: error });
  }
  const store = await openStore({ url: process.env.DATABASE_URL, file: process.env.WORKSPACE_DB });
  const origin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  const app = await createWorkspace({ store, origin });
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, "0.0.0.0", () => console.log("Workspace listening on port", port));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await app.close(); });
}
