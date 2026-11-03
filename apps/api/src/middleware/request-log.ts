// SPDX-License-Identifier: Apache-2.0
/**
 * The access log — one line per request, with the path and never the query.
 *
 * 🚨 **Hono's `logger()` prints the whole URL, and this app puts live capabilities in its
 * query strings.** An unsubscribe link carries its token as `?token=…`, a share link as
 * `/s/{token}`, and the AT Protocol callback carries `code` and `state`; all of them land in
 * stdout and whatever log pipeline reads it. A bearer credential in a log stream is a
 * credential, and the log keeps it long after the link expires.
 *
 * The path is what a request is worth reading for. Nothing in this app routes on a query
 * string, so dropping it loses no diagnostic value — and the method plus status plus duration
 * is the same line Hono printed.
 */
import type { MiddlewareHandler } from "hono";

export const requestLog: MiddlewareHandler = async (c, next) => {
	const started = Date.now();
	await next();
	const line = `${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`;
	console.log(line);
};
