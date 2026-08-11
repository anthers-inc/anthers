// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The API's process entry point — the Bun.serve configuration.
 *
 * This file exists so that `index.ts` can go on exporting the Hono app itself. The two
 * roles look like one thing and are not: Bun takes the entry module's DEFAULT EXPORT as
 * its server config (`{ port, fetch, websocket }`), while all 28 API test suites do
 * `import app from "../index"` and call `app.fetch(new Request(...))`. Those are only
 * compatible while `fetch` is a one-argument function returning a Response.
 *
 * They stopped being compatible once the P2P work needed a WebSocket upgrade intercepted
 * ahead of Hono, because that makes `fetch` take `(req, server)` and return `undefined`
 * after a successful upgrade. Merging the two roles into `index.ts` to get that took
 * `main` red on 2026-08-10 with 680 typecheck errors — one `TS2554` per suite plus ~650
 * `TS18048: 'res' is possibly 'undefined'` — none of which were test bugs. The damage
 * lands on the tests rather than at the edit site, which is what made it read as a test
 * problem when it never was.
 *
 * So: routing lives in `index.ts`, process concerns live here, and the two do not mix.
 * Anything that needs the Bun server object — WebSocket handlers, port binding, upgrade
 * interception — belongs in this file.
 *
 * Everything that names an entry point must name THIS one: `.do/app.yaml`'s api
 * `run_command`, `apps/api/Dockerfile`'s CMD, `apps/api/package.json`'s dev/start
 * scripts, and `apps/web/playwright.config.ts`'s webServer. Note that pushing to
 * `release` never applies the committed spec — a change here needs
 * `doctl apps update --spec`, and `make spec-diff` is what catches forgetting.
 */

import type { Server } from "bun";
import app from "./index.js";
import { ensureQueueReady } from "./jobs/queue.js";
import { type SignalSocketData, signalingWebSocket, tryUpgradeSignaling } from "./p2p/signaling.js";

// Start the job queue. This used to be guarded by `import.meta.main` in index.ts so that
// importing the app from a test never started a queue; now that index.ts is only ever
// imported and this file is only ever an entry point, the guard is unnecessary — being
// here IS the condition it was testing for.
ensureQueueReady().catch((err) => console.error("Job queue failed to start:", err));

export default {
	port: Number(process.env.PORT ?? 8000),

	/**
	 * The P2P signaling relay is intercepted here, ahead of Hono, because a WebSocket
	 * upgrade needs the Bun server object and Hono never sees one. Three outcomes, and the
	 * middle one is why `tryUpgradeSignaling` reports `null` rather than `undefined` for a
	 * request it doesn't want: after a successful upgrade this handler must return nothing
	 * at all, so "upgraded" and "not mine" cannot share a return value.
	 */
	fetch(req: Request, server: Server<SignalSocketData>): Response | Promise<Response> | undefined {
		const signal = tryUpgradeSignaling(req, server);
		if (signal) return signal.upgraded ? undefined : signal.response;
		return app.fetch(req);
	},

	websocket: signalingWebSocket,
};
