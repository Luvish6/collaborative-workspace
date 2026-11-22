import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

const byId = id => document.getElementById(id);
const status = byId("status");
const editor = byId("document");
const title = byId("document-title");
const people = byId("people");
const displayName = byId("name");
const id = location.hash.slice(1);
const roomPattern = /^[A-Za-z0-9_-]{24}$/;
const createButtons = [byId("create"), byId("create-recent")];
const service = byId("service");
const retry = byId("retry");
const recentKey = "side-by-side:recent";
let available = false;
let creating = false;
let healthRequest = 0;

function readRecents() {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) || "[]");
    return Array.isArray(value) ? value.filter(item =>
      item && roomPattern.test(item.id) && typeof item.title === "string" && Number.isFinite(item.updated)) : [];
  } catch {
    return [];
  }
}

function remember(value) {
  try {
    const rows = [{ id, title: value || "Untitled document", updated: Date.now() },
      ...readRecents().filter(row => row.id !== id)].slice(0, 12);
    localStorage.setItem(recentKey, JSON.stringify(rows));
  } catch {
    // Recent shortcuts are optional when browser storage is restricted.
  }
}

function showDocuments() {
  byId("welcome").hidden = true;
  byId("dashboard").hidden = false;
  byId("workspace").hidden = true;
  byId("features-link").hidden = true;
  const rows = readRecents();
  byId("recent").replaceChildren(...rows.map(row => {
    const link = document.createElement("a");
    link.className = "document-card";
    link.href = "#" + row.id;
    const name = document.createElement("strong");
    name.textContent = row.title;
    const date = document.createElement("span");
    date.textContent = new Date(row.updated).toLocaleDateString();
    link.append(name, date);
    return link;
  }));
  byId("recent-empty").hidden = rows.length > 0;
}

function updateButtons() {
  for (const button of createButtons) button.disabled = !available || creating;
}

async function checkHealth() {
  const request = ++healthRequest;
  available = false;
  updateButtons();
  retry.hidden = true;
  service.dataset.state = "checking";
  byId("service-message").textContent = "Checking server…";
  try {
    const response = await fetch("./health", { signal: AbortSignal.timeout(12000), cache: "no-store" });
    if (!response.ok || (await response.json()).status !== "ok") throw new Error();
    if (request !== healthRequest) return;
    available = true;
    service.dataset.state = "online";
    byId("service-message").textContent = "Server online";
  } catch {
    if (request !== healthRequest) return;
    service.dataset.state = "offline";
    byId("service-message").textContent = "Server unavailable or waking up. Retry to create a workspace.";
    retry.hidden = false;
  } finally {
    if (request === healthRequest) updateButtons();
  }
}

retry.addEventListener("click", checkHealth);
window.addEventListener("online", checkHealth);
window.addEventListener("offline", checkHealth);
checkHealth();

for (const button of [byId("documents-nav"), byId("browse"), byId("back-documents")]) {
  button.disabled = false;
  button.addEventListener("click", () => {
    if (roomPattern.test(id)) location.hash = "documents";
    else {
      history.replaceState(null, "", "#documents");
      showDocuments();
    }
  });
}

byId("open-form").addEventListener("submit", event => {
  event.preventDefault();
  const raw = byId("invite").value.trim();
  try {
    const url = new URL(roomPattern.test(raw) ? "#" + raw : raw, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || !roomPattern.test(url.hash.slice(1))) {
      throw new Error();
    }
    location.hash = url.hash;
  } catch {
    byId("open-error").textContent = "Enter an invite link from this Side by Side site.";
  }
});

async function createRoom() {
  if (!available || creating) return;
  creating = true;
  updateButtons();
  byId("service-message").textContent = "Creating workspace…";
  byId("creation-error").textContent = "";
  try {
    const response = await fetch("./api/rooms", { method: "POST", signal: AbortSignal.timeout(15000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !roomPattern.test(result.id)) throw new Error(result.error || "Unable to create workspace.");
    location.hash = result.id;
  } catch (error) {
    byId("creation-error").textContent = error.message || "Unable to create a workspace.";
    checkHealth();
  } finally {
    creating = false;
    updateButtons();
  }
}
for (const button of createButtons) button.addEventListener("click", createRoom);
window.addEventListener("hashchange", () => {
  if (location.hash !== "#features" || roomPattern.test(id)) location.reload();
});

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

if (id === "documents") showDocuments();
else if (id && id !== "features" && !roomPattern.test(id)) {
  byId("creation-error").textContent = "This invite link is invalid.";
} else if (roomPattern.test(id)) {
  byId("welcome").hidden = true;
  byId("workspace").hidden = false;
  byId("features-link").hidden = true;
  const doc = new Y.Doc();
  const text = doc.getText("document");
  const titleText = doc.getText("title");
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
  let compositionField;
  let localCache = false;

  function render() {
    if (composing) return;
    for (const [field, model] of [[editor, text], [title, titleText]]) {
      const value = model.toString();
      if (field.value === value) continue;
      const { start, deleted, inserted } = change(field.value, value);
      field.setRangeText(inserted, start, start + deleted, "preserve");
    }
    byId("length").textContent = text.length.toLocaleString() + " / 100,000 characters";
  }

  function edit(model, base, value) {
    const { start, deleted, inserted } = change(base, value);
    doc.transact(() => {
      if (deleted) model.delete(start, deleted);
      if (inserted) model.insert(start, inserted);
    });
  }

  let deferred = [];
  for (const [field, model] of [[editor, text], [title, titleText]]) {
    field.addEventListener("compositionstart", () => {
      composing = true;
      compositionField = field;
      compositionBase = model.toString();
    });
    field.addEventListener("compositionend", () => {
      if (compositionField !== field) return;
      composing = false;
      edit(model, compositionBase, field.value);
      for (const update of deferred) Y.applyUpdate(doc, update, remote);
      deferred = [];
      render();
    });
    field.addEventListener("input", () => {
      if (!composing) edit(model, model.toString(), field.value);
    });
  }
  titleText.observe(() => remember(titleText.toString()));

  function enableEditor() {
    editor.disabled = title.disabled = byId("download").disabled = false;
    remember(titleText.toString());
  }

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
    socket = new WebSocket(new URL("./live/" + id, location.href).href.replace(/^http/, "ws"));
    socket.binaryType = "arraybuffer";
    socket.onopen = sendName;
    socket.onmessage = event => {
      if (typeof event.data === "string") {
        const names = JSON.parse(event.data).people;
        byId("presence-empty").hidden = names.length > 0;
        people.replaceChildren(...names.map(name => {
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
          enableEditor();
          if (!available) checkHealth();
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
      byId("presence-empty").hidden = false;
      if (available) checkHealth();
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
      if (text.length || titleText.length) enableEditor();
      render();
    }).catch(() => {});
  } catch {
    // Editing and synchronization still work in browsers with local storage disabled.
  }
  render();
  connect();
}
