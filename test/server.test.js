import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";
import { createAppServer } from "../server.js";

async function startServer(dataDir = undefined) {
  const resolvedDataDir = dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "draft-test-")));
  const server = await createAppServer({ dataDir: resolvedDataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let closed = false;
  return {
    dataDir: resolvedDataDir,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close({ removeData = true } = {}) {
      if (!closed) {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await server.flushPersistence();
        closed = true;
      }
      if (removeData) await rm(resolvedDataDir, { recursive: true, force: true });
    },
  };
}

async function json(response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function readUntil(reader, initial, marker) {
  const decoder = new TextDecoder();
  let value = initial;
  while (!value.includes(marker)) {
    const { value: chunk, done } = await reader.read();
    assert.equal(done, false);
    value += decoder.decode(chunk, { stream: true });
  }
  return value;
}

test("serves the editor and starts with a persistent welcome document", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const page = await fetch(app.baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Collaborative documents/);

  const { documents } = await json(await fetch(`${app.baseUrl}/api/documents`));
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, "welcome");
  assert.match(documents[0].content, /real time/);
});

test("creates documents, validates titles, and persists document changes after restart", async (t) => {
  const app = await startServer();
  let restarted;
  t.after(async () => {
    if (restarted) await restarted.close();
    else await app.close();
  });
  const created = await json(
    await fetch(`${app.baseUrl}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Sprint notes" }),
    }),
  );
  const id = created.document.id;
  assert.equal(created.document.title, "Sprint notes");

  const renamed = await fetch(`${app.baseUrl}/api/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Sprint review" }),
  });
  assert.equal((await json(renamed)).document.title, "Sprint review");

  const invalid = await fetch(`${app.baseUrl}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(invalid.status, 400);

  const client = new Y.Doc();
  client.getText("content").insert(0, "Decisions from today's meeting");
  const update = Buffer.from(Y.encodeStateAsUpdate(client)).toString("base64");
  const accepted = await fetch(`${app.baseUrl}/api/documents/${id}/updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ update }),
  });
  assert.equal(accepted.status, 202);
  assert.match((await json(await fetch(`${app.baseUrl}/api/documents/${id}`))).document.content, /today's meeting/);

  await app.close({ removeData: false });
  restarted = await startServer(app.dataDir);
  const { document } = await json(await fetch(`${restarted.baseUrl}/api/documents/${id}`));
  assert.equal(document.title, "Sprint review");
  assert.equal(document.content, "Decisions from today's meeting");
});

test("broadcasts updates over the document event stream and merges concurrent Yjs edits", async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const { documents } = await json(await fetch(`${app.baseUrl}/api/documents`));
  const id = documents[0].id;
  const stream = await fetch(`${app.baseUrl}/api/documents/${id}/events`);
  assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = stream.body.getReader();
  let received = "";
  received = await readUntil(reader, received, "event: sync");
  received = await readUntil(reader, received, "event: presence");

  const first = new Y.Doc();
  const second = new Y.Doc();
  const initialState = JSON.parse(received.split("data: ")[1].split("\n")[0]).update;
  Y.applyUpdate(first, Buffer.from(initialState, "base64"));
  Y.applyUpdate(second, Buffer.from(initialState, "base64"));
  first.getText("content").insert(0, "First ");
  second.getText("content").insert(0, "Second ");

  for (const [index, client] of [first, second].entries()) {
    const response = await fetch(`${app.baseUrl}/api/documents/${id}/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update: Buffer.from(Y.encodeStateAsUpdate(client)).toString("base64"),
      }),
    });
    assert.equal(response.status, 202);
    if (index === 0) {
      received = await readUntil(reader, received, "event: update");
      assert.match(received, /event: update\ndata: \{"update":/);
    }
  }

  const { document } = await json(await fetch(`${app.baseUrl}/api/documents/${id}`));
  assert.match(document.content, /First/);
  assert.match(document.content, /Second/);
  assert.ok(document.revision >= 2);
  await reader.cancel();
});
