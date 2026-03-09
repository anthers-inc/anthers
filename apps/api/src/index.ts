import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { csrfProtection } from "./middleware/csrf.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";

const app = new Hono()
	.use(logger())
	.use(secureHeaders())
	.use(
		cors({
			origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
			credentials: true,
		}),
	)
	.use(csrfProtection)
	.get("/health", (c) => c.json({ status: "ok" }))
	.route("/api/auth", authRoutes)
	.route("/api/projects", projectRoutes);

export default {
	port: Number(process.env.PORT ?? 8000),
	fetch: app.fetch,
};

export type AppType = typeof app;
