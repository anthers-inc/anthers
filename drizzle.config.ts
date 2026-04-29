import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./packages/db/src/schema",
	out: "./packages/db/drizzle",
	dialect: "sqlite",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "file:./data/anthers.sqlite",
	},
});
