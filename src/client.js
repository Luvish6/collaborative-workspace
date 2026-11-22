import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

const byId = id => document.getElementById(id);
const status = byId("status");
const editor = byId("document");
const people = byId("people");
const displayName = byId("name");
const id = location.hash.slice(1);

byId("create").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  byId("creation-error").textContent = "";
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    location.hash = result.id;
  } catch (error) {
    byId("creation-error").textContent = error.message || "Unable to create a workspace.";
  } finally {
    button.disabled = false;
  }
});
window.addEventListener("hashchange", () => location.reload());

function change(before, after) {
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  // Yjs text indexes are UTF-16. Keep edits off surrogate-pair boundaries.
  if (start && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  let end = 0;
  while (end < Math.min(before.length, after.length) - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  if (end && /[\uDC00-\uDFFF]/.test(before[before.length - end])) end--;
  return { start, deleted: before.length - start - end, inserted: after.slice(start, after.length - end) };
}

if (id && !/^[A-Za-z0-9_-]{24}$/.test(id)) {
  status.textContent = "Invalid invite link";
} else if (id) {
  byId("welcome").hidden = true;
  byId("workspace").hidden = false;
  const doc = new Y.Doc();
  const text = doc.getText("document");
  const remote = Symbol("server");
  let socket;
  let vector;
  let pending;
  let revision = 0;
  let saved = -1;
  let timer;
  let retries = 0;
  let composing = false;
  let compositionBase;
  let localCache = false;

  function render() {
    if (composing) return;
    const value = text.toString();
    if (editor.value !== value) {
      const { start, deleted, inserted } = change(editor.value, value);
      editor.setRangeText(inserted, start, start + deleted, "preserve");
    }
    byId("length").textContent = value.length.toLocaleString() + " / 100,000 characters";
  }

  function edit(base, value) {
    const { start, deleted, inserted } = change(base, value);
    doc.transact(() => {
      if (deleted) text.delete(start, deleted);
      if (inserted) text.insert(start, inserted);
    });
  }

  let deferred = [];
  editor.addEventListener("compositionstart", () => {
    composing = true;
    compositionBase = text.toString();
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    edit(compositionBase, editor.value);
    for (const update of deferred) Y.applyUpdate(doc, update, remote);
    deferred = [];
    render();
  });
  editor.addEventListener("input", () => {
    if (!composing) edit(text.toString(), editor.value);
  });

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(send, 75);
  }

  function send() {
    if (socket?.readyState !== WebSocket.OPEN || !vector || pending || revision === saved) return;
    const update = Y.encodeStateAsUpdate(doc, vector);
    if (update.length > 512 * 1024) {
      status.textContent = "Sync history limit reached. Export your text to preserve it.";
      return;
    }
    pending = { revision, vector: Y.encodeStateVector(doc) };
    socket.send(update);
    status.textContent = "Saving…";
  }

  doc.on("update", (_, origin) => {
    render();
    if (origin !== remote) {
      revision++;
      if (vector) {
        status.textContent = "Saving…";
        schedule();
      }
    }
  });

  function sendName() {
    if (socket?.readyState === WebSocket.OPEN) socket.send(displayName.value.trim() || "Guest");
  }

  function connect() {
    status.textContent = "Connecting…";
    socket = new WebSocket(new URL("/live/" + id, location.href).href.replace(/^http/, "ws"));
    socket.binaryType = "arraybuffer";
    socket.onopen = sendName;
    socket.onmessage = event => {
      if (typeof event.data === "string") {
        people.replaceChildren(...JSON.parse(event.data).people.map(name => {
          const item = document.createElement("li");
          item.textContent = name;
          return item;
        }));
        return;
      }
      const message = new Uint8Array(event.data);
      const update = message.subarray(1);
      if (message[0] === 2 && pending) {
        vector = pending.vector;
        saved = pending.revision;
        pending = undefined;
        if (revision === saved) status.textContent = "Saved · live";
        else schedule();
      } else if (message[0] === 0 || message[0] === 1) {
        if (composing) deferred.push(update);
        else Y.applyUpdate(doc, update, remote);
        if (message[0] === 0) {
          const source = new Y.Doc();
          Y.applyUpdate(source, update);
          vector = Y.encodeStateVector(source);
          source.destroy();
          editor.disabled = false;
          retries = 0;
          render();
          schedule();
        }
      }
    };
    socket.onclose = event => {
      vector = pending = undefined;
      saved = -1;
      people.replaceChildren();
      if (event.code === 1008 || event.code === 1009) {
        status.textContent = "Server rejected a change. Export your text.";
        return;
      }
      status.textContent = editor.disabled ? "Unable to join · retrying" :
        localCache ? "Offline · changes kept on this device" : "Offline · keep this tab open to preserve changes";
      setTimeout(connect, Math.min(15000, 600 * 2 ** Math.min(retries++, 5)));
    };
  }

  displayName.addEventListener("change", sendName);
  byId("share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      byId("link-feedback").textContent = "Invite link copied.";
    } catch {
      byId("link-feedback").textContent = "Copy the invite link from your address bar.";
    }
  });
  byId("download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([text.toString()], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "shared-document.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  try {
    const cache = new IndexeddbPersistence("workspace-" + id, doc);
    cache.whenSynced.then(() => {
      localCache = true;
      if (text.length) editor.disabled = false;
      render();
    }).catch(() => {});
  } catch {
    // Editing and synchronization still work in browsers with local storage disabled.
  }
  render();
  connect();
}
