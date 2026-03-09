import {
	boolean,
	integer,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const projects = pgTable("projects", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	title: varchar("title", { length: 255 }).notNull(),
	slug: varchar("slug", { length: 255 }).notNull().unique(),
	description: text("description").default(""),
	pricingModel: varchar("pricing_model", { length: 20 }).notNull().default("free"), // free | pwyw | paid
	price: numeric("price", { precision: 10, scale: 2 }),
	minPrice: numeric("min_price", { precision: 10, scale: 2 }),
	published: boolean("published").default(false),
	coverImage: varchar("cover_image", { length: 500 }).default(""),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
