// SPDX-License-Identifier: Apache-2.0
// Side-effect import, and it must stay FIRST: it fills non-secret config from the
// committed .do/app.yaml before any route module reads process.env. No-ops in
// production, where that file is not in the image. See dev-spec-env.ts.
import "./dev-spec-env.js";
import { isDevCheckout } from "@anthers/db/dev-only";
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
import { createBuildDeliveryRoutes, isBuildDeliveryRequest } from "./routes/build-delivery.js";
import { contentRoutes } from "./routes/content.js";
import { createDevBuildRoutes } from "./routes/dev-build.js";
import { dmcaRoutes } from "./routes/dmca.js";
import { integrationRoutes } from "./routes/integrations.js";
import { moderationRoutes } from "./routes/moderation.js";
import { paymentRoutes } from "./routes/payments.js";
import { createPlayPageRoutes } from "./routes/play-page.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { webBuildRoutes } from "./routes/web-builds.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { alertDue, alertOperational, captureError, redactRoute } from "./services/error-tracker.js";
import { isQuarantinedKey } from "./services/storage/acl.js";
import { isLocalStorage } from "./services/storage/index.js";
import { LocalStorageService } from "./services/storage/local.js";

const app = new Hono()
	.use(logger())
	// The dev build-delivery harness frames its build from the preview page, which is a
	// different origin (port) than this API, and `secureHeaders` below stamps
	// `X-Frame-Options: SAMEORIGIN` on every response — which blocks exactly that frame.
	// A build can never be same-origin with the thing embedding it (that's the whole point of
	// anthers.run), so for these routes and only these routes the header comes off. This is
	// registered BEFORE `secureHeaders` so its post-`next()` segment runs after and wins.
	// Dev-only, refuse-closed: the registration of the routes is gated on `isDevCheckout()`.
	.use("/api/dev/build/*", async (c, next) => {
		await next();
		c.res.headers.delete("X-Frame-Options");
	})
	// The same for the production delivery routes: the Work page frames the entry URL,
	// which answers on the Work's delivery host — a different origin from the page by
	// design. Host-scoped by the same guard the routes themselves refuse on, so the
	// header comes off nowhere else.
	.use("/build/*", async (c, next) => {
		await next();
		if (isBuildDeliveryRequest(c.req.url)) c.res.headers.delete("X-Frame-Options");
	})
	.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin" }))
	.use(
		cors({
			origin: allowedOrigins(),
			credentials: true,
		}),
	)
	.use(csrfProtection)
	// The hand-rolled error tracker: every unhandled exception in a route lands here —
	// fingerprinted, deduped into `error_events`, and alerted on first sight. Registered
	// before the routes so it sees everything they throw. Its own failure logs and
	// continues; a capture that fails is never the error that pages (services/error-tracker.ts).
	.onError(async (error, c) => {
		const captured = await captureError({
			source: "api",
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			context: { route: redactRoute(c.req.path), method: c.req.method },
		});
		const due = captured ? (captured.firstSeen ? true : await alertDue(captured)) : false;
		if (captured && due) {
			await alertOperational(captured, error, c.req);
		}
		console.error(`[api] unhandled error on ${c.req.method} ${c.req.path}:`, error);
		return c.json({ error: "Something went wrong" }, 500);
	})
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
		return serveStatic({
			root: LocalStorageService.getContentRoot(),
			rewriteRequestPath: (path) => path.slice("/content".length),
		})(c, next);
	})
	.get("/health", (c) => c.json({ status: "ok" }))
	.route("/api/auth", authRoutes)
	.route("/api/atproto", atprotoRoutes)
	.route("/api/accounts", accountRoutes)
	.route("/api/content", contentRoutes)
	.route("/api/payments", paymentRoutes)
	.route("/api/subscriptions", subscriptionRoutes)
	.route("/api/integrations", integrationRoutes)
	.route("/api/moderation", moderationRoutes)
	.route("/api/dmca", dmcaRoutes)
	// The browser-build routes live on their own mount rather than under /api/content:
	// two routers at one mount path merge at runtime but not in the typed RPC client, so
	// `client.api.content.works[":id"].web-build…` does not type. A distinct prefix keeps
	// the client honest; the routes still address /works/:id inside it.
	.route("/api/web-builds", webBuildRoutes)
	// Build delivery — the file half. Mounted unconditionally in DEV; in production the
	// routes answer only on a delivery host (the host guard in the module), and the
	// mount itself goes in only when `BUILD_ORIGIN_SUFFIX` names one. Refuses closed in
	// both directions, the same shape `admin-host.ts` runs.
	.route("/build", createBuildDeliveryRoutes())
	// The play page — the server-rendered parent an isolation build plays inside. Same
	// host as the API (anthers.org), by design: it is the page that holds the session
	// AND carries COOP/COEP, which is the combination the SPA cannot be. Under /api
	// rather than bare /play because production ingress routes only /api (and /health)
	// to this component — a bare path would fall to the web static site and 404.
	.route("/api/play", createPlayPageRoutes())
	.route("/api/admin", adminRoutes)
	.route("/api/webhooks", webhookRoutes);

/**
 * The dev-only build-delivery harness, registered only from a checkout. Keeping the mount
 * here — rather than inside `createDevBuildRoutes` — is the first of the three refuse-closed
 * layers: the production image carries no `.do/app.yaml` and no `Makefile`, so the route is
 * never attached there and `/api/dev/build/*` 404s. The module enforces the other two.
 */
const devApp = isDevCheckout() ? app.route("/api/dev", createDevBuildRoutes()) : app;

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
export default devApp;

export type AppType = typeof devApp;
