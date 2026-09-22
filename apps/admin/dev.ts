// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's dev server, `admin.anthers` beside `anthers` (the site) and
 * `api.anthers` under portless, or on :3001 when run without it.
 *
 * As with the site, the URL under portless is `https://admin.anthers.localhost`; under the
 * direct fallback it is `http://127.0.0.1:3001` — the `127.0.0.1` spelling matters because
 * the session cookie the API sets is host-scoped, and `localhost` is a different host.
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

console.log(`Admin dev server on ${process.env.PORTLESS_URL ?? `http://127.0.0.1:${server.port}`}`);
