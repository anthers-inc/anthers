// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { ensureQueueReady } from "./jobs/queue.js";
import { csrfProtection } from "./middleware/csrf.js";
import { allowedOrigins } from "./origins.js";
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
import { matchesInviteKey, matchesSitePassword } from "./site-gate.js";

const app = new Hono()
	.use(logger())
	.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin" }))
	.use(
		cors({
			origin: allowedOrigins(),
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
	// Authorizes a visitor past the pre-launch SiteGate. Two ways in, same result
	// (the client's anthers_site_access flag): `password` is typed into the gate,
	// `invite` rides in on a ?invite= link we handed out.
	.post("/health/gate", async (c) => {
		const data = await c.req.json().catch(() => null);
		if (!data) return c.json({ ok: false }, 400);
		if (typeof data.password === "string" && matchesSitePassword(data.password)) {
			return c.json({ ok: true });
		}
		if (typeof data.invite === "string" && matchesInviteKey(data.invite)) {
			return c.json({ ok: true });
		}
		return c.json({ ok: false }, 403);
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
