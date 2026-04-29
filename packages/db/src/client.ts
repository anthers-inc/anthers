import { Database as SqliteDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema/index.js";

const url = process.env.DATABASE_URL ?? "./data/anthers.db";
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
