// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's dev server, on :3001 beside the site on :3000 and the API on :8000.
 *
 * Use `127.0.0.1` rather than `localhost`, as for the site: the admin session cookie is set by the
 * API on `127.0.0.1:8000`, and a browser treats the two names as different hosts.
 */
import { serve } from "bun";
import index from "./index.html";
import { assertPortFree } from "./src/lib/dev-port.js";

const port = Number(process.env.PORT ?? 3001);
assertPortFree(port);

const server = serve({
	port,
	development: { hmr: true, console: true },
	routes: { "/*": index },
});

console.log(`Admin dev server on http://127.0.0.1:${server.port}`);
