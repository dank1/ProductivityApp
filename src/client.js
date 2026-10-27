import * as Y from "yjs";

const list = document.querySelector("#document-list");
const editor = document.querySelector("#editor");
const titleInput = document.querySelector("#document-title");
const emptyState = document.querySelector("#empty-state");
const editorPanel = document.querySelector("#editor-panel");
const wordCount = document.querySelector("#word-count");
const saveStatus = document.querySelector("#save-status");
const presence = document.querySelector("#presence");
const newDocumentButton = document.querySelector("#new-document");
const mobileMenuButton = document.querySelector("#mobile-menu");
const sidebar = document.querySelector("#sidebar");
const shareButton = document.querySelector("#share-document");

let activeId = null;
let activeDocument = null;
let openVersion = 0;
let eventSource = null;
let titleTimer = null;
let titleRequest = Promise.resolve();
let titleChanged = false;
let localEdit = false;

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Something went wrong.");
  return result;
}

function showStatus(message, state = "saved") {
  saveStatus.textContent = message;
  saveStatus.dataset.state = state;
}

function updateWordCount() {
  const words = editor.value.trim().split(/\s+/).filter(Boolean).length;
  wordCount.textContent = `${words} ${words === 1 ? "word" : "words"}`;
}

function updatePresence(count = 0) {
  presence.querySelector(".presence-count").textContent =
    count > 1 ? `${count} people here` : "Just you";
  presence.dataset.online = String(count > 0);
}

function renderDocumentList(documents) {
  list.replaceChildren();
  for (const doc of documents) {
    const button = document.createElement("button");
    button.className = "document-link";
    button.type = "button";
    button.dataset.active = String(doc.id === activeId);

    const icon = document.createElement("span");
    icon.className = "document-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = doc.title.trim().charAt(0).toUpperCase() || "D";

    const text = document.createElement("span");
    text.className = "document-link-copy";
    const title = document.createElement("span");
    title.className = "document-link-title";
    title.textContent = doc.title;
    const date = document.createElement("span");
    date.className = "document-link-date";
    date.textContent = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(doc.updatedAt));
    text.append(title, date);
    button.append(icon, text);
    button.addEventListener("click", () => openDocument(doc.id));
    list.append(button);
  }
}

async function refreshDocuments() {
  const { documents } = await request("/api/documents");
  renderDocumentList(documents);
  return { documents };
}

function closeActiveDocument() {
  eventSource?.close();
  eventSource = null;
  activeDocument?.ydoc.destroy();
  activeDocument = null;
}

function applyRemoteText(value) {
  if (editor.value === value) return;
  const previous = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  let prefix = 0;
  while (prefix < previous.length && prefix < value.length && previous[prefix] === value[prefix]) {
    prefix += 1;
  }
  let oldEnd = previous.length;
  let newEnd = value.length;
  while (oldEnd > prefix && newEnd > prefix && previous[oldEnd - 1] === value[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const delta = (newEnd - prefix) - (oldEnd - prefix);
  const movePosition = (position) => {
    if (position <= prefix) return position;
    if (position >= oldEnd) return position + delta;
    return newEnd;
  };
  editor.value = value;
  editor.setSelectionRange(movePosition(start), movePosition(end));
  updateWordCount();
}

async function openDocument(id) {
  const version = ++openVersion;
  clearTimeout(titleTimer);
  saveTitle();
  try {
    const { document: metadata } = await request(`/api/documents/${id}`);
    if (version !== openVersion) return;
    closeActiveDocument();
    activeId = id;
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    activeDocument = { ydoc: new Y.Doc(), metadata };
    const openedDocument = activeDocument;
    const ytext = openedDocument.ydoc.getText("content");
    editor.value = "";
    titleInput.value = metadata.title;
    titleChanged = false;
    editorPanel.hidden = false;
    emptyState.hidden = true;
    showStatus("Connecting…", "saving");
    updatePresence(0);

    openedDocument.ydoc.on("update", (update, origin) => {
      if (origin === "remote") return;
      showStatus("Saving…", "saving");
      fetch(`/api/documents/${id}/updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update: toBase64(update) }),
      }).then((response) => {
        if (!response.ok) throw new Error("The latest edit could not be saved.");
        showStatus("Saved", "saved");
      }).catch(() => showStatus("Couldn't save changes", "error"));
    });
    ytext.observe(() => {
      if (localEdit) return;
      applyRemoteText(ytext.toString());
    });

    eventSource = new EventSource(`/api/documents/${id}/events`);
    eventSource.addEventListener("sync", (event) => {
      const data = JSON.parse(event.data);
      if (activeDocument !== openedDocument) return;
      Y.applyUpdate(openedDocument.ydoc, fromBase64(data.update), "remote");
      showStatus("All changes saved", "saved");
      void refreshDocuments();
    });
    eventSource.addEventListener("update", (event) => {
      const data = JSON.parse(event.data);
      if (activeDocument !== openedDocument) return;
      Y.applyUpdate(openedDocument.ydoc, fromBase64(data.update), "remote");
      showStatus("All changes saved", "saved");
    });
    eventSource.addEventListener("metadata", (event) => {
      const data = JSON.parse(event.data);
      if (activeDocument !== openedDocument) return;
      activeDocument.metadata = data;
      if (!titleChanged) titleInput.value = data.title;
      void refreshDocuments();
    });
    eventSource.addEventListener("presence", (event) => {
      if (activeDocument !== openedDocument) return;
      updatePresence(JSON.parse(event.data).count);
    });
    eventSource.onopen = () => {
      if (activeDocument === openedDocument) showStatus("Live", "saved");
    };
    eventSource.onerror = () => {
      if (activeDocument === openedDocument) showStatus("Reconnecting…", "saving");
    };
    await refreshDocuments();
    sidebar.classList.remove("mobile-open");
  } catch (error) {
    if (version === openVersion) showStatus(error.message, "error");
  }
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

editor.addEventListener("input", () => {
  if (!activeDocument) return;
  const ytext = activeDocument.ydoc.getText("content");
  const current = ytext.toString();
  const next = editor.value;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) {
    prefix += 1;
  }
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > prefix && nextEnd > prefix && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }
  localEdit = true;
  activeDocument.ydoc.transact(() => {
    if (currentEnd > prefix) ytext.delete(prefix, currentEnd - prefix);
    if (nextEnd > prefix) ytext.insert(prefix, next.slice(prefix, nextEnd));
  });
  localEdit = false;
  updateWordCount();
});

function saveTitle() {
  if (!activeId || !titleChanged) return;
  const id = activeId;
  const title = titleInput.value.trim() || "Untitled document";
  titleInput.value = title;
  titleChanged = false;
  titleRequest = titleRequest
    .catch(() => {})
    .then(() =>
      request(`/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    )
    .then(() => refreshDocuments())
    .catch((error) => showStatus(error.message, "error"));
}

titleInput.addEventListener("input", () => {
  titleChanged = true;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(saveTitle, 350);
});
titleInput.addEventListener("blur", saveTitle);
titleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") titleInput.blur();
});

async function createDocument() {
  try {
    const { document } = await request("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled document" }),
    });
    await openDocument(document.id);
    titleInput.focus();
    titleInput.select();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

newDocumentButton.addEventListener("click", createDocument);
document.querySelector("#empty-create").addEventListener("click", createDocument);

mobileMenuButton.addEventListener("click", () => sidebar.classList.toggle("mobile-open"));
document.querySelector("#mobile-menu-trigger").addEventListener("click", () =>
  sidebar.classList.add("mobile-open"),
);

refreshDocuments()
  .then(({ documents } = {}) => {
    if (!documents?.length) return;
    const requestedId = location.hash.slice(1);
    const initialDocument = documents.find((document) => document.id === requestedId) ?? documents[0];
    return openDocument(initialDocument.id);
  })
  .catch((error) => showStatus(error.message, "error"));

window.addEventListener("hashchange", () => {
  const requestedId = location.hash.slice(1);
  if (requestedId && requestedId !== activeId) void openDocument(requestedId);
});

shareButton.addEventListener("click", async () => {
  if (!activeId) return;
  try {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${activeId}`);
    showStatus("Document link copied", "saved");
  } catch {
    showStatus("Could not copy the document link", "error");
  }
});
