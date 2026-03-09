import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema/index.js";

export const db = drizzle(process.env.DATABASE_URL!, { schema });
export type Database = typeof db;
