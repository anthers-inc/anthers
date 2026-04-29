import { Database as SqliteDatabase } from "bun:sqlite";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema/index.js";

// Resolve relative DATABASE_URLs against the project root (import.meta.dir
// is packages/db/src). This keeps the default working regardless of which
// workspace the command was launched from — bun --filter changes cwd.
const projectRoot = resolve(import.meta.dir, "..", "..", "..");
const raw = process.env.DATABASE_URL ?? "./data/anthers.sqlite";
const url = raw.startsWith("/") ? raw : resolve(projectRoot, raw);

const sqlite = new SqliteDatabase(url, { create: true });

// foreign_keys: required for ON DELETE CASCADE / SET NULL.
// busy_timeout: SQLite serializes writers per-file; this gives concurrent
//   writers (API + worker, even though the queue lives in its own file)
//   transparent retry headroom before SQLITE_BUSY surfaces.
// journal_mode WAL: lets readers run alongside the active writer.
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA busy_timeout = 5000;");
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });
export type Database = typeof db;
