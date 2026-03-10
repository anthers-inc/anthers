import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { projects } from "@anthers/db/schema";
import { requireAuth } from "../middleware/auth.js";

const createProjectSchema = z.object({
	title: z.string().min(1).max(255),
	slug: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
	description: z.string().max(10000).optional(),
	pricingType: z.enum(["free", "pwyw", "paid"]).default("free"),
	price: z.string().optional(), // numeric as string for precision
	minPrice: z.string().optional(),
});

const projectRoutes = new Hono()
	.get("/", async (c) => {
		const allProjects = await db
			.select()
			.from(projects)
			.orderBy(projects.createdAt);

		return c.json({ projects: allProjects });
	})
	.post("/", requireAuth, zValidator("json", createProjectSchema), async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		// Check slug uniqueness
		const existing = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, data.slug))
			.limit(1);

		if (existing.length > 0) {
			return c.json({ error: "A project with this slug already exists" }, 409);
		}

		const [project] = await db
			.insert(projects)
			.values({
			creatorId: user.id,
			title: data.title,
			slug: data.slug,
			description: data.description ?? "",
			pricingType: data.pricingType,
			price: data.price ?? null,
			minPrice: data.minPrice ?? null,
			})
			.returning();

		return c.json({ project }, 201);
	});

export { projectRoutes };
