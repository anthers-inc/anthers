# Bun Feature Reference

**What Bun is:** An all-in-one JavaScript/TypeScript runtime that replaces Node.js and most of its surrounding toolchain. Single binary, built on JavaScriptCore (WebKit's engine), written in Zig. Drop-in Node.js compatible for >95% of npm packages.

**When referencing previous projects for patterns, replace the following with Bun equivalents.**

---

## Package Manager

**Replaces:** npm, yarn, pnpm

- `bun install` — installs dependencies from package.json (~10× faster than npm)
- `bun add <pkg>` — add dependency
- `bun add -d <pkg>` — add dev dependency
- `bun remove <pkg>` — remove dependency
- `bun update` — update dependencies
- `bunx <pkg>` — replaces `npx`
- `bun patch <pkg>` — patch packages directly
- `bun list` — list installed packages
- Uses `package.json` and `node_modules` — fully compatible with existing ecosystem
- Lockfile: `bun.lockb` (binary) or `bun.lock` (text, JSONC format)

## Runtime

**Replaces:** Node.js, ts-node, tsx, nodemon

- `bun run <file.ts>` — runs TypeScript and JSX natively, zero config, no transpilation step
- `bun run <file.js>` — runs JavaScript
- `bun --watch <file>` — hot reload on file changes (replaces nodemon)
- `bun --hot <file>` — hot reload preserving application state
- Supports both ESM (`import`) and CommonJS (`require`) in the same file
- Reads `.env` files automatically (no dotenv package needed)
- `Bun.serve()` — built-in HTTP server with WebSocket support
- `Bun.file()` — fast file I/O API
- `Bun.write()` — fast file writing
- `Bun.spawn()` / `Bun.spawnSync()` — subprocess API
- `Bun.password` — built-in password hashing (argon2, bcrypt)
- `Bun.CryptoHasher` — built-in hashing (SHA-256, etc.)
- `Bun.Glob` — built-in glob matching (no glob/minimatch package needed)
- `Bun.Terminal` — terminal UI API (as of v1.3.5)
- Built-in `fetch()`, `WebSocket`, `Request`, `Response`, `URL`, `URLPattern`, and other Web APIs
- Standalone executables: `bun build --compile` produces a single binary with no runtime dependency

## TypeScript

**Replaces:** tsc (for execution), ts-node, tsx, ts-jest, any tsconfig transpilation-only config

- Runs `.ts`, `.tsx`, `.jsx` files directly — no compile step
- No `tsconfig.json` required for execution (still usable for editor/type-checking config)
- Type stripping happens at native speed, not through a JS-based transpiler

**Does NOT replace:** `tsc` for type checking. Bun executes TypeScript but does not type-check it. Keep `tsc --noEmit` or an editor plugin for type safety.

## Bundler

**Replaces:** Webpack, Vite (build step), esbuild, Rollup, Parcel

- `bun build ./src/index.ts --outdir ./dist` — production bundling
- `bun build --compile` — compile to standalone executable
- `bun build --minify` — minification built in
- Tree shaking, code splitting, source maps included
- CSS bundling supported
- Handles JSX/TSX natively
- `bun build --target=browser` — browser builds
- `bun build --target=bun` — server builds
- As of v1.3: zero-config frontend dev server with HMR and React Fast Refresh (`bun <file.html>`)

**Note:** For complex frontend dev workflows (React dev server with proxy, HMR, plugin ecosystem), Vite may still be preferable as a dev server. Bun can run Vite (`bun run vite`) faster than Node would.

## Test Runner

**Replaces:** Jest, Vitest, Mocha, Chai, ts-jest

- `bun test` — Jest-compatible test runner, zero config
- Supports `describe`, `it`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`
- Snapshot testing
- Mock functions (`mock()`)
- Fake timers (as of v1.3.4)
- `onTestFinished` hook
- DOM testing with `bun:test` + happy-dom
- Coverage with `--coverage`
- Watch mode with `--watch`
- Runs `.test.ts` / `.test.tsx` files natively (no ts-jest config)

## Script Runner

**Replaces:** npm scripts, npx, Makefile (for JS tasks)

- `bun run <script>` — runs package.json scripts
- Faster script execution than `npm run` (no shell overhead)
- `bunx` replaces `npx` for one-off package execution
- Bun Shell (`Bun.$`) — cross-platform shell scripting in JS/TS:
  ```ts
  import { $ } from "bun";
  await $`echo hello && ls -la`;
  ```

## Built-in Database Clients (v1.3+)

**Replaces:** pg, mysql2, better-sqlite3, knex (for simple queries)

- `Bun.SQL` — unified API supporting PostgreSQL, MySQL, MariaDB, SQLite
- Zero external dependencies
- Tagged template literal syntax:
  ```ts
  import { SQL } from "bun";
  const db = new SQL("postgres://...");
  const users = await db`SELECT * FROM users WHERE id = ${id}`;
  ```
- Built-in SQLite via `bun:sqlite` (available since v1.0)

## Built-in S3 Client

**Replaces:** @aws-sdk/client-s3 (for basic operations)

- `Bun.s3` — native S3-compatible object storage client
- Supports upload, download, presigned URLs
- Content-Disposition support (v1.3.5)
- Works with any S3-compatible provider (AWS, DigitalOcean Spaces, MinIO, etc.)

## WebSocket Server

**Replaces:** ws, socket.io (for basic WebSocket needs)

- Built into `Bun.serve()`:
  ```ts
  Bun.serve({
    fetch(req, server) {
      server.upgrade(req);
    },
    websocket: {
      message(ws, msg) { ws.send(msg); },
      open(ws) { ws.subscribe("room"); },
    },
  });
  ```
- Pub/sub built in (`ws.subscribe()`, `ws.publish()`)
- Significantly faster than ws package on Node

## HTTP Server

**Replaces:** Express (for simple servers), Fastify, http module

- `Bun.serve()` — high-performance HTTP server using Web API Request/Response
- Handles ~5× more requests/second than Node.js http module
- TLS support built in
- Streaming responses supported
- For framework-level routing, use Bun-native frameworks: **Elysia** or **Hono** (both run on Bun natively and are significantly faster than Express)

---

## What Bun Does NOT Replace

| Tool/Concern | Why It Stays |
|---|---|
| **Django / Python backend** | Bun is JS/TS only. Django, Celery, Python ORM, all unchanged. |
| **tsc type checking** | Bun runs TS but doesn't type-check. Keep tsc --noEmit for CI. |
| **Vite dev server** (optional) | For complex React HMR/plugin workflows, Vite on top of Bun may be preferable to Bun's built-in dev server. |
| **Docker** | Bun runs inside containers, doesn't replace them. Official Docker image: `oven/bun` |
| **CDN / object storage / infra** | Runtime tool, not infrastructure. |
| **Database ORMs** (Prisma, Drizzle) | Bun.SQL is a raw client. ORMs still needed for migration/schema management if desired. |
| **CI/CD pipelines** | Bun runs in CI (faster), but doesn't replace GitHub Actions/GitLab CI. |

---

## Migration Patterns

When porting from a Node.js project:

| Old Pattern | Bun Equivalent |
|---|---|
| `npm install` | `bun install` |
| `npx create-react-app` | `bunx create-react-app` or `bun create` |
| `node server.js` | `bun server.js` or `bun server.ts` |
| `ts-node script.ts` | `bun script.ts` |
| `nodemon --watch src` | `bun --watch src/index.ts` |
| `jest` / `vitest` | `bun test` |
| `npm run build` (webpack/vite) | `bun build ./src/index.ts --outdir ./dist` |
| `require('dotenv').config()` | Automatic — Bun reads .env files natively |
| `require('pg')` | `import { SQL } from "bun"` (Bun.SQL) |
| `require('ws')` | `Bun.serve({ websocket: ... })` |
| `require('express')` | `Bun.serve()` + Elysia/Hono for routing |
| `require('glob')` | `new Bun.Glob(pattern)` |
| `require('bcrypt')` | `Bun.password.hash()` / `Bun.password.verify()` |
| `require('crypto').createHash()` | `new Bun.CryptoHasher("sha256")` |
| `child_process.spawn()` | `Bun.spawn()` |
| `fs.readFile()` | `Bun.file(path).text()` or node:fs (both work) |
| `@aws-sdk/client-s3` | `Bun.s3` (for basic S3 operations) |