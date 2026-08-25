// SPDX-License-Identifier: AGPL-3.0-or-later
// Side-effect import, and it must stay FIRST: it fills non-secret config from the
// committed .do/app.yaml before any route module reads process.env. No-ops in
// production, where that file is not in the image. See dev-spec-env.ts.
import "./dev-spec-env.js";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { csrfProtection } from "./middleware/csrf.js";
import { allowedOrigins } from "./origins.js";
import { accountRoutes } from "./routes/accounts.js";
import { adminRoutes } from "./routes/admin.js";
import { atprotoRoutes } from "./routes/atproto.js";
import { authRoutes } from "./routes/auth.js";
import { contentRoutes } from "./routes/content.js";
import { dmcaRoutes } from "./routes/dmca.js";
import { integrationRoutes } from "./routes/integrations.js";
import { moderationRoutes } from "./routes/moderation.js";
import { paymentRoutes } from "./routes/payments.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { isQuarantinedKey } from "./services/storage/acl.js";
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
		// 🚨 Quarantined material sits under CONTENT_ROOT like everything else, and this
		// middleware serves that directory unsigned and unauthenticated. In S3 mode the
		// private bucket has no public door, so refusing to sign the key is enough; here
		// the directory IS the door and a guessed path would open it. Refused before
		// serveStatic looks at the filesystem at all.
		if (isQuarantinedKey(decodeURIComponent(c.req.path).slice("/content/".length))) {
			return c.json({ error: "Not found" }, 404);
		}
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
	.route("/api/moderation", moderationRoutes)
	.route("/api/dmca", dmcaRoutes)
	.route("/api/waitlist", waitlistRoutes)
	.route("/api/admin", adminRoutes);

// This module is the Hono app and nothing else. It is never a process entry point —
// `server.ts` is, and it owns the Bun.serve object (port, fetch, websocket).
//
// Keep it that way. The two roles look like one thing: Bun reads the entry module's
// default export as its server config, while all 28 API suites do
// `import app from "../index"` and call `app.fetch(new Request(...))`. Those are only
// compatible while `fetch` is a one-argument function returning a Response — and the
// P2P work needed a WebSocket upgrade intercepted ahead of Hono, which makes it
// `(req, server)` returning `undefined` after an upgrade. Merging the roles to get that
// took `main` red with 680 typecheck errors across every suite, none of them test bugs.
//
// So a WebSocket handler, an upgrade intercept, or anything else wanting the Bun server
// object goes in `server.ts`. Adding it here breaks the tests, at a distance, in a way
// that reads as their fault.
export default app;

export type AppType = typeof app;
