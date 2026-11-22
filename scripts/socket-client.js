import { WebSocket } from "ws";
import * as Y from "yjs";

export async function makeRoom(base) {
  const response = await fetch(base + "/api/rooms", { method: "POST", headers: { Origin: base } });
  if (!response.ok) throw new Error("Room creation returned " + response.status);
  return (await response.json()).id;
}

export function joinRoom(base, id, doc = new Y.Doc(), origin = base) {
  const socket = new WebSocket(base.replace(/^http/, "ws") + "/live/" + id, { origin });
  const waiters = new Set();
  let closed;
  let initial;
  let ack = 0;
  let people = [];
  function check() {
    for (const waiter of waiters) {
      if (!closed && !waiter.condition()) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      if (closed) waiter.reject(closed);
      else waiter.resolve();
    }
  }
  socket.on("message", (packet, binary) => {
    if (binary) {
      if (packet[0] === 0 || packet[0] === 1) Y.applyUpdate(doc, packet.subarray(1));
      if (packet[0] === 0) initial = true;
      if (packet[0] === 2) ack++;
    } else {
      people = JSON.parse(packet.toString()).people;
    }
    check();
  });
  socket.on("error", error => { closed = error; check(); });
  socket.on("close", () => { closed ||= new Error("Socket closed"); check(); });
  function wait(condition) {
    if (closed) return Promise.reject(closed);
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { condition, resolve, reject };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for workspace"));
      }, 7000);
      waiters.add(waiter);
    });
  }
  return {
    socket, doc, text: doc.getText("document"), wait,
    ready: () => wait(() => initial),
    presence: () => people,
    send(data) {
      const expected = ack + 1;
      socket.send(data);
      return wait(() => ack >= expected);
    }
  };
}
