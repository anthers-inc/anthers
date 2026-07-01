// SPDX-License-Identifier: AGPL-3.0-or-later
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema/index.js";

// The hub runs on Postgres (DigitalOcean Managed Postgres in prod, a local
// containerized Postgres in dev — see docker-compose.yml). SQLite remains the
// engine for the future creator-node role, not this client.
//
// DATABASE_URL is required; the dev default targets the local compose Postgres.
const url = process.env.DATABASE_URL ?? "postgres://anthers:anthers@localhost:5432/anthers";

const client = new SQL(url);

export const db = drizzle({ client, schema });
export type Database = typeof db;
