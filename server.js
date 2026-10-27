import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const storeFileName = "documents.json";
const maxBodyBytes = 1024 * 1024;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function documentSummary(document) {
  return {
    id: document.id,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    revision: document.revision,
    content: document.ydoc.getText("content").toString(),
  };
}

function jsonResponse(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBodyBytes * 2) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.toString("base64") === value;
}

export async function createAppServer({ dataDir = path.join(root, "data") } = {}) {
  await mkdir(dataDir, { recursive: true });
  const storePath = path.join(dataDir, storeFileName);
  const documents = new Map();
  const streams = new Map();
  let persistChain = Promise.resolve();
  let persistTimer;

  const createDocument = ({ id = randomUUID(), title = "Untitled document", content = "" } = {}) => {
    const now = new Date().toISOString();
    const ydoc = new Y.Doc();
    if (content) ydoc.getText("content").insert(0, content);
    const document = { id, title, createdAt: now, updatedAt: now, revision: 0, ydoc };
    documents.set(id, document);
    attachDocument(document);
    return document;
  };

  const persist = () => {
    const snapshot = [...documents.values()].map((document) => ({
      id: document.id,
      title: document.title,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      revision: document.revision,
      state: Buffer.from(Y.encodeStateAsUpdate(document.ydoc)).toString("base64"),
    }));
    persistChain = persistChain.then(async () => {
      const temporaryPath = `${storePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
      await rename(temporaryPath, storePath);
    });
    return persistChain;
  };

  const schedulePersist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persist().catch((error) => console.error("Could not save documents:", error));
    }, 75);
  };

  function broadcast(document, event, payload) {
    const clients = streams.get(document.id);
    if (!clients) return;
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) response.write(data);
  }

  function attachDocument(document) {
    document.ydoc.on("update", (update) => {
      document.revision += 1;
      document.updatedAt = new Date().toISOString();
      const payload = {
        update: Buffer.from(update).toString("base64"),
        revision: document.revision,
        updatedAt: document.updatedAt,
      };
      broadcast(document, "update", payload);
      broadcast(document, "metadata", documentSummary(document));
      schedulePersist();
    });
  }

  try {
    const savedDocuments = JSON.parse(await readFile(storePath, "utf8"));
    if (!Array.isArray(savedDocuments)) throw new Error("Document store must contain an array.");
    for (const saved of savedDocuments) {
      if (!saved || typeof saved.id !== "string" || !validBase64(saved.state)) {
        throw new Error("Document store contains an invalid document.");
      }
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, Buffer.from(saved.state, "base64"));
      const document = {
        id: saved.id,
        title: typeof saved.title === "string" ? saved.title : "Untitled document",
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        revision: Number.isInteger(saved.revision) ? saved.revision : 0,
        ydoc,
      };
      documents.set(document.id, document);
      attachDocument(document);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (documents.size === 0) {
    createDocument({
      id: "welcome",
      title: "Welcome to Draft",
      content:
        "A calm space for ideas, meeting notes, and plans.\n\n" +
        "Open this document in another window to collaborate in real time. " +
        "Changes sync as you type and are saved automatically.",
    });
    await persist();
  }

  const serveStatic = async (request, response, pathname) => {
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!["index.html", "styles.css", "app.js"].includes(file)) {
      jsonResponse(response, 404, { error: "Not found." });
      return;
    }
    try {
      const contents = await readFile(path.join(root, "public", file));
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(file)],
        "Cache-Control": file === "index.html" ? "no-cache" : "public, max-age=3600",
      });
      response.end(contents);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      jsonResponse(response, 503, { error: "The app is not built yet. Run npm run build." });
    }
  };

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname;
    if (request.method === "GET" && !pathname.startsWith("/api/")) {
      await serveStatic(request, response, pathname);
      return;
    }

    if (request.method === "GET" && pathname === "/api/documents") {
      const summaries = [...documents.values()]
        .map(documentSummary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      jsonResponse(response, 200, { documents: summaries });
      return;
    }

    if (request.method === "POST" && pathname === "/api/documents") {
      const body = await readJson(request);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > 120) {
        jsonResponse(response, 400, { error: "Title must be between 1 and 120 characters." });
        return;
      }
      const document = createDocument({ title });
      await persist();
      jsonResponse(response, 201, { document: documentSummary(document) });
      return;
    }

    const match = pathname.match(/^\/api\/documents\/([a-zA-Z0-9-]+)(?:\/(events|updates))?$/);
    if (!match) {
      jsonResponse(response, 404, { error: "Not found." });
      return;
    }

    const [, id, action] = match;
    const document = documents.get(id);
    if (!document) {
      jsonResponse(response, 404, { error: "Document not found." });
      return;
    }

    if (request.method === "GET" && !action) {
      jsonResponse(response, 200, { document: documentSummary(document) });
      return;
    }

    if (request.method === "PATCH" && !action) {
      const body = await readJson(request);
      if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 120) {
        jsonResponse(response, 400, { error: "Title must be between 1 and 120 characters." });
        return;
      }
      document.title = body.title.trim();
      document.updatedAt = new Date().toISOString();
      await persist();
      const summary = documentSummary(document);
      broadcast(document, "metadata", summary);
      jsonResponse(response, 200, { document: summary });
      return;
    }

    if (request.method === "GET" && action === "events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(
        `event: sync\ndata: ${JSON.stringify({
          update: Buffer.from(Y.encodeStateAsUpdate(document.ydoc)).toString("base64"),
          document: documentSummary(document),
        })}\n\n`,
      );
      let clients = streams.get(id);
      if (!clients) streams.set(id, (clients = new Set()));
      clients.add(response);
      broadcast(document, "presence", { count: clients.size });
      response.on("close", () => {
        clients.delete(response);
        if (clients.size === 0) streams.delete(id);
        else broadcast(document, "presence", { count: clients.size });
      });
      return;
    }

    if (request.method === "POST" && action === "updates") {
      const body = await readJson(request);
      if (!validBase64(body.update)) {
        jsonResponse(response, 400, { error: "Update must be a non-empty base64 string." });
        return;
      }
      Y.applyUpdate(document.ydoc, Buffer.from(body.update, "base64"));
      jsonResponse(response, 202, {
        document: documentSummary(document),
      });
      return;
    }

    jsonResponse(response, 405, { error: "Method not allowed." });
  };

  const server = createHttpServer((request, response) => {
    handler(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      jsonResponse(response, error.status ?? 500, {
        error: error.status ? error.message : "The request could not be completed.",
      });
      if (!error.status) console.error("Request failed:", error);
    });
  });
  server.flushPersistence = async () => {
    clearTimeout(persistTimer);
    await persist();
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createAppServer();
  server.listen(port, () => {
    console.log(`Draft is ready at http://localhost:${port}`);
  });
}
