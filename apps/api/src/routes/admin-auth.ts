// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in to the admin app: an emailed code, sent only to an admin account's own address.
 *
 * The same ceremony as `/api/auth/signin/*` on the main site, against separate tables. It never
 * creates an account — admin accounts are invited from the app's Accounts section or created by
 * `scripts/admin-account.ts`. It is mounted inside `routes/admin.ts`, behind `adminHostOnly`, so it
 * answers only on the admin host and only to the admin origin (see `middleware/admin.ts`).
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
	clearAdminSessionCookie,
	readAdminSessionCookie,
	setAdminSessionCookie,
} from "../lib/cookies.js";
import { type AdminEnv, requireAdminSession } from "../middleware/admin.js";
import { invalidBody } from "../middleware/validate.js";
import {
	ADMIN_SESSION_TTL_MS,
	checkAdminSignInCode,
	createAdminSession,
	deleteAdminSession,
	issueAdminSignInCode,
	serializeAdminAccount,
} from "../services/admin-accounts.js";
import { sendAdminSignInCodeEmail } from "../services/email.js";

const startSchema = z.object({
	email: z.string().email().max(254),
});

const verifySchema = z.object({
	email: z.string().email().max(254),
	/** Loose for the reason given on the main site's `emailCodeVerifySchema`. */
	code: z.string().trim().length(6),
});

export const adminAuthRoutes = new Hono<AdminEnv>()

	// Step 1 — issue a code to an active admin account's address. ALWAYS 200, with an identical
	// body whether or not the address belongs to anybody.
	.post("/signin/start", zValidator("json", startSchema, invalidBody), async (c) => {
		const { email } = c.req.valid("json");
		try {
			const issued = await issueAdminSignInCode(email);
			if (issued.code) {
				// Off the response path, so the time the request takes cannot say whether the
				// address has an admin account.
				void sendAdminSignInCodeEmail(email, issued.code).catch((err) => {
					console.error("[admin signin/start] failed to send the code:", err);
				});
			}
		} catch (err) {
			console.error("[admin signin/start] failed to issue a code:", err);
		}
		return c.json({ success: true });
	})

	// Step 2 — spend the code and start a session.
	.post("/signin/verify", zValidator("json", verifySchema, invalidBody), async (c) => {
		const { email, code } = c.req.valid("json");
		const result = await checkAdminSignInCode(email, code);
		if (!result.ok || !result.account) {
			const tooMany = !result.ok && result.reason === "too_many_attempts";
			return c.json(
				{
					error: tooMany
						? "Too many attempts. Ask for a new code."
						: "That code didn't work. Check it, or ask for a new one.",
				},
				tooMany ? 429 : 400,
			);
		}

		const token = await createAdminSession(
			result.account.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setAdminSessionCookie(c, token, ADMIN_SESSION_TTL_MS / 1000);
		return c.json({ account: serializeAdminAccount(result.account) });
	})

	.post("/sign-out", async (c) => {
		const token = readAdminSessionCookie(c);
		if (token) await deleteAdminSession(token);
		clearAdminSessionCookie(c);
		return c.json({ success: true });
	})

	.get("/me", requireAdminSession, (c) => {
		// The site's origin travels with the account so the app can link to a Work or a profile on the
		// main site without guessing it from its own host name.
		return c.json({ account: serializeAdminAccount(c.get("admin")), siteUrl: siteOrigin() });
	});

/** The main site's origin, from `FRONTEND_URL`, for links out of the admin app. */
function siteOrigin(): string {
	return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
