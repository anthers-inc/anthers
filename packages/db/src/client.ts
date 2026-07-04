// SPDX-License-Identifier: AGPL-3.0-or-later
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

// The hub runs on Postgres (DigitalOcean Managed Postgres in prod, a local
// containerized Postgres in dev — see docker-compose.yml). SQLite remains the
// engine for the future creator-node role, not this client.
//
// postgres.js (not Bun's built-in SQL): drizzle's bun-sql driver double-encodes
// jsonb (stores '["a"]' as a jsonb *string* rather than an array), which breaks
// the jsonb columns (tags, dpopJwk, waveformData). postgres.js stores jsonb
// correctly and still returns numeric/bigint as strings (preserving decimal.js
// precision) and timestamptz as Date.
//
// DATABASE_URL is required; the dev default targets the local compose Postgres.
const url = process.env.DATABASE_URL ?? "postgres://anthers:anthers@localhost:5432/anthers";

// Small pool: the hub runs several Postgres consumers (api + worker each hold a
// postgres-js pool AND a pg-boss pool) against a managed cluster with a low
// max_connections (~25). Cap each pool so a rolling deploy — which briefly
// doubles every component — can't exhaust the connection budget.
const client = postgres(url, { max: 3 });

export const db = drizzle(client, { schema });
export type Database = typeof db;
