# Draft

Draft is a lightweight collaborative document editor. It uses a small Node.js HTTP server, Yjs shared text for conflict-free real-time editing, server-sent events to distribute updates and presence, and an atomic JSON file store for persistence.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Create documents with the **+** button, then use **Share** to copy a link to the current document. Anyone who can access that link can edit alongside you; changes and online presence update live.

`npm start` builds the browser bundle and starts the server. Set `PORT` to use a different port. Document data is stored in `data/documents.json`; keep that directory private and back it up with the rest of your application data.

## Checks

```sh
npm test
```

The tests cover the editor route, document creation and validation, Yjs update merging, event streaming, and persistence across server restarts.

## Scope

This starter runs as a single server process and is intended for a trusted local or private environment. It does not include user accounts, access controls, or invite links; do not expose it to the public internet without adding authentication and authorization.
