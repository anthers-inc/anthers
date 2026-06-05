// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { ensureQueueReady } from "./jobs/queue.js";
import { csrfProtection } from "./middleware/csrf.js";
import { accountRoutes } from "./routes/accounts.js";
import { atprotoRoutes } from "./routes/atproto.js";
import { authRoutes } from "./routes/auth.js";
import { contentRoutes } from "./routes/content.js";
import { integrationRoutes } from "./routes/integrations.js";
import { jamRoutes } from "./routes/jams.js";
import { paymentRoutes } from "./routes/payments.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { isLocalStorage } from "./services/storage/index.js";

const app = new Hono()
	.use(logger())
	.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin" }))
	.use(
		cors({
			origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
			credentials: true,
		}),
	)
	.use(csrfProtection)
	// Serve uploaded content files from local filesystem in dev mode
	.use("/content/*", async (c, next) => {
		if (!isLocalStorage) return next();
		return serveStatic({ root: "../../" })(c, next);
	})
	.get("/health", (c) => c.json({ status: "ok" }))
	.post("/health/gate", async (c) => {
		const expected = process.env.SITE_PASSWORD ?? "";
		if (!expected) return c.json({ ok: false }, 403);
		const data = await c.req.json().catch(() => null);
		if (!data) return c.json({ ok: false }, 400);
		if (data.password !== expected) return c.json({ ok: false }, 403);
		return c.json({ ok: true });
	})
	.route("/api/auth", authRoutes)
	.route("/api/atproto", atprotoRoutes)
	.route("/api/accounts", accountRoutes)
	.route("/api/content", contentRoutes)
	.route("/api/payments", paymentRoutes)
	.route("/api/subscriptions", subscriptionRoutes)
	.route("/api/integrations", integrationRoutes)
	.route("/api/jams", jamRoutes)
	.route("/api/waitlist", waitlistRoutes);

// Start the job queue when running as the server (not when imported by tests).
// import.meta.main is true only when this file is the entry point.
if (import.meta.main) {
	ensureQueueReady().catch((err) => console.error("Job queue failed to start:", err));
}

export default {
	port: Number(process.env.PORT ?? 8000),
	fetch: app.fetch,
};

export type AppType = typeof app;
