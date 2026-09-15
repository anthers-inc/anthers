// SPDX-License-Identifier: Apache-2.0
/**
 * Which requests are addressed to the admin app.
 *
 * The admin app is served from its own host (`admin.anthers.org`), and the API routes behind it
 * answer only there and 404 on every other host, so the main site does not advertise that the
 * console exists. `ADMIN_URL` names that host, the same way `FRONTEND_URL` names the site's.
 *
 * ⚠️ **This check is about not advertising the console, and it is not what keeps anybody out.**
 * A request can claim any `Host` it likes. What keeps people out is the admin session cookie,
 * which is host-only on the admin host and `SameSite=Strict`, so it is never sent anywhere else,
 * plus the rule in `middleware/admin.ts` that a mutation must come from the admin origin. A
 * forged `Host` reaches a sign-in form and nothing behind it.
 *
 * ⭐ **Every answer here fails closed.** A public deployment with no `ADMIN_URL` has no admin host,
 * so the routes answer nowhere rather than everywhere. Only a repository checkout with no
 * `ADMIN_URL` — `make dev` and the test runner, where the admin app and the API are on different
 * ports of one machine — accepts any host, and a test that wants the check exercised sets
 * `ADMIN_URL` to a `.test` address.
 */
import { allowedOrigins } from "../origins.js";
import { isPublicDeployment } from "./deployment.js";

type Env = Record<string, string | undefined>;

/** The admin app's origin from `ADMIN_URL`, or null when it is unset or not a URL. */
export function adminOrigin(env: Env = process.env): string | null {
	const raw = env.ADMIN_URL?.trim();
	if (!raw) return null;
	try {
		return new URL(raw).origin;
	} catch {
		return null;
	}
}

/**
 * Whether a request whose URL has this host is addressed to the admin app.
 *
 * Takes the host of the request URL rather than a `Host` header, because that is what `Bun.serve`
 * builds the URL from and what a test's `app.request` URL carries.
 */
export function isAdminHost(host: string, env: Env = process.env): boolean {
	const origin = adminOrigin(env);
	if (origin) return host.toLowerCase() === new URL(origin).host;
	return !isPublicDeployment(env);
}

/**
 * Whether a mutating request's `Origin` is the admin app.
 *
 * Stricter than the site-wide CSRF check, which admits the site and the desktop Studio: neither
 * has any business changing anything through the admin routes. In a checkout with no `ADMIN_URL`
 * the admin app runs on a localhost port, so the dev origins the site-wide check allows stand in.
 */
export function isAdminOrigin(origin: string | undefined, env: Env = process.env): boolean {
	if (!origin) return false;
	const admin = adminOrigin(env);
	if (admin) return origin === admin;
	if (isPublicDeployment(env)) return false;
	return allowedOrigins().includes(origin);
}
