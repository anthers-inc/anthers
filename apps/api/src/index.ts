// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { ensureQueueReady } from "./jobs/queue.js";
import { csrfProtection } from "./middleware/csrf.js";
import { allowedOrigins } from "./origins.js";
import { p2pRoutes } from "./p2p/routes.js";
import { accountRoutes } from "./routes/accounts.js";
import { adminRoutes } from "./routes/admin.js";
import { atprotoRoutes } from "./routes/atproto.js";
import { authRoutes } from "./routes/auth.js";
import { contentRoutes } from "./routes/content.js";
import { integrationRoutes } from "./routes/integrations.js";
import { jamRoutes } from "./routes/jams.js";
import { moderationRoutes } from "./routes/moderation.js";
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
	.route("/api/moderation", moderationRoutes)
	.route("/api/waitlist", waitlistRoutes)
	.route("/api/admin", adminRoutes)
	// Production P2P delivery routes — manifest, chunk, pubkey (per 45.04 + 45.05).
	.route("/api/p2p", p2pRoutes);

// Start the job queue when running as the server (not when imported by tests).
// import.meta.main is true only when this file is the entry point.
if (import.meta.main) {
	ensureQueueReady().catch((err) => console.error("Job queue failed to start:", err));
}

// This default export is BOTH the Bun.serve config for production and the handle
// every API test drives the app through (`import app from "../index"`, then
// `app.fetch(new Request(...))`). Those two roles are only compatible while `fetch`
// stays a one-argument function returning a Response.
//
// The P2P spike briefly broke that. It replaced `fetch: app.fetch` with a Bun.serve
// handler — `fetch(req, server)`, returning `undefined` after a successful
// `server.upgrade()` — to intercept a WebSocket signaling relay before Hono. Both
// changes are correct for Bun and invisible at runtime (627 tests still passed), but
// they moved the exported contract out from under all 28 test files at once: 680
// typecheck errors, one `TS2554: Expected 2 arguments` per file plus ~650
// `TS18048: 'res' is possibly 'undefined'`, which took `main` red on 2026-08-10.
//
// So when the real signaling relay lands with milestone 9 of the P2P lane, do NOT
// widen this signature again — the type breakage lands on the tests, not here, which
// is what made it look like a test problem when it never was. Split the entry point
// instead: a `server.ts` that owns the Bun.serve object (fetch + websocket), leaving
// this file exporting the Hono app. That is a deploy-config change — `.do/app.yaml`'s
// api run_command, apps/api/Dockerfile, playwright.config.ts's webServer and the dev
// scripts all name this file as the entry — so it wants to be deliberate rather than
// a side effect of adding a route.
export default {
	port: Number(process.env.PORT ?? 8000),
	fetch: app.fetch,
};

export type AppType = typeof app;
