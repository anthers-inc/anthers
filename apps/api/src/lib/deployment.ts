// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether this process is serving a public deployment, and at what origin.
 *
 * 🚨 **Three security branches asked `NODE_ENV` this question, and `NODE_ENV` is set nowhere
 * in the Anthers app.** It appears zero times in the live App Platform spec, so every
 * `process.env.NODE_ENV === "production"` was false in production and silently took its
 * development branch: the CORS/CSRF allowlist admitted `http://localhost:3000` as a
 * credentialed origin on `anthers.org`, and neither the session cookie nor the ATProto
 * pending-signup cookie was marked `Secure`.
 *
 * ⭐ **The answer is to detect the thing itself rather than a proxy for it.** An https origin
 * *is* what "deployed somewhere public" means — it is the fact all three call sites actually
 * care about, it cannot become true on a developer's machine by accident, and it is already
 * configured because the app cannot serve anybody without it. `NODE_ENV` is a label somebody
 * has to remember to set, and nobody did.
 *
 * ⚠️ **Setting `NODE_ENV=production` in `.do/app.yaml` was considered and rejected.** One line
 * would have repaired all three at once, which is exactly what makes it tempting, but it is a
 * global switch that changes behavior in every library that reads it, on a live app, to fix
 * three specific call sites. It also leaves the fragility in place: the next branch somebody
 * writes on `NODE_ENV` is correct only for as long as nobody removes the variable.
 *
 * `getBaseUrl()` in `services/atproto-client.ts` reached this shape first, on 2026-08-22,
 * after the same defect shipped ATProto OAuth broken twice. It reads `publicOrigin()` now, so
 * there is one definition of "public" in the API rather than two that can drift.
 */

/**
 * The variables that name where this deployment is reachable from outside, in priority order.
 *
 * `BASE_URL` is the API's own public origin and comes first because it is the more specific
 * claim. `FRONTEND_URL` is what production actually sets — `${APP_URL}` in `.do/app.yaml`,
 * which resolves to the primary domain — and is the one that answers in practice.
 */
const PUBLIC_ORIGIN_KEYS = ["BASE_URL", "FRONTEND_URL"] as const;

/**
 * The public https origin this process is deployed at, or `null` when there is none.
 *
 * ⚠️ **The scheme is the discriminator, and it has to be.** Dev sets `FRONTEND_URL` too, to
 * `http://localhost:3000`, so a check for whether the variable is *set* would call every
 * developer's machine production. Only `https://` counts.
 *
 * The environment is injectable for the same reason `resolveStorageConfig()` and
 * `loadSharedSpecEnv()` take one: every rule here is a decision about production
 * configuration, and each should be testable against a fixture rather than against whatever
 * this machine happens to have in `.env`.
 */
export function publicOrigin(env: Record<string, string | undefined> = process.env): string | null {
	for (const key of PUBLIC_ORIGIN_KEYS) {
		const value = (env[key] ?? "").trim().replace(/\/+$/, "");
		if (value.toLowerCase().startsWith("https://")) return value;
	}
	return null;
}

/**
 * True when this process is serving a public deployment — the question the CORS/CSRF
 * allowlist and both cookie writers ask before they decide how strict to be.
 *
 * ⭐ **Every caller must be written so that `true` is the strict answer**, because that is the
 * direction an unset variable fails in. A caller that relaxed something on `true` would
 * reintroduce the original defect with a new name.
 */
export function isPublicDeployment(env: Record<string, string | undefined> = process.env): boolean {
	return publicOrigin(env) !== null;
}
