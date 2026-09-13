// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./packages/db/src/schema",
	out: "./packages/db/drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://anthers:anthers@localhost:5432/anthers",
	},
});
