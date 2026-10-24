// SPDX-License-Identifier: Apache-2.0
/**
 * Linking an Anthers account to Discord.
 *
 * Endpoints:
 *   GET  /connect   — send the browser to Discord's consent screen
 *   GET  /callback  — exchange the code, join the server, store the link
 *   POST /unlink    — forget the link and take back the Creator role
 *
 * ⚠️ **The callback is a bare `GET` and the CSRF middleware never sees it** — that middleware
 * checks mutating methods only. What makes the round trip safe is the pair of cookies: a random
 * state written before the redirect and compared on return, and the session cookie that says
 * which account is linking. Both are required, and both are `SameSite=Lax`, which a top-level
 * navigation from Discord still carries.
 *
 * Every failure lands back on the Account tab with a `discord=` code rather than in JSON,
 * because the person arrives here by navigating, not by fetching.
 */
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { setSecureCookie } from "../lib/cookies.js";
import { getOptionalUserId, requireAuth } from "../middleware/auth.js";
import {
	addMemberToServer,
	discordAuthorizationUrl,
	discordConfigured,
	exchangeAuthorizationCode,
	syncAccountRoles,
	unlinkAccount,
} from "../services/discord.js";

const STATE_COOKIE = "discord_oauth_state";
/** Long enough for a consent screen somebody reads, short enough not to linger. */
const STATE_MAX_AGE = 10 * 60;

function frontendUrl(): string {
	return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Back to the card that started this, with the outcome in the query. */
function back(c: Context, outcome: string): Response {
	return c.redirect(`${frontendUrl()}/settings?tab=account&discord=${outcome}`);
}

export const discordRoutes = new Hono()
	.get("/connect", requireAuth, (c) => {
		if (!discordConfigured()) {
			return c.json({ error: "Discord is not connected yet." }, 503);
		}
		const state = crypto.randomUUID();
		setSecureCookie(c, STATE_COOKIE, state, STATE_MAX_AGE);
		return c.redirect(discordAuthorizationUrl(state));
	})

	.get("/callback", async (c) => {
		const state = c.req.query("state");
		const expected = getCookie(c, STATE_COOKIE);
		deleteCookie(c, STATE_COOKIE, { path: "/" });

		const userId = await getOptionalUserId(c);
		if (userId === null) return back(c, "signin");
		if (!discordConfigured()) return back(c, "unavailable");
		if (c.req.query("error")) return back(c, "denied");
		if (!state || !expected || state !== expected) return back(c, "state");
		const code = c.req.query("code");
		if (!code) return back(c, "error");

		let discordUserId: string;
		let accessToken: string;
		try {
			const exchanged = await exchangeAuthorizationCode(code);
			discordUserId = exchanged.discordUser.id;
			accessToken = exchanged.accessToken;
		} catch (error) {
			console.error("[discord] code exchange failed", error);
			return back(c, "error");
		}

		// One Discord account, one Anthers account. The unique index is the real guard; this
		// read turns the common case into a sentence instead of a constraint violation.
		const [holder] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.discordId, discordUserId), ne(users.id, userId)))
			.limit(1);
		if (holder) return back(c, "taken");

		try {
			await addMemberToServer(discordUserId, accessToken);
		} catch (error) {
			// Not linked, so a retry is the whole recovery. The bot's role sitting too low is
			// the usual cause, and the card says so rather than pretending it worked.
			console.error("[discord] joining the server failed", error);
			return back(c, "join");
		}

		try {
			await db.update(users).set({ discordId: discordUserId }).where(eq(users.id, userId));
		} catch {
			// The unique index caught a race the read above could not see.
			return back(c, "taken");
		}

		// A role failure must not lose the link: the daily reconcile is the repair, and the
		// person is already in the server either way.
		try {
			await syncAccountRoles(userId);
		} catch (error) {
			console.error("[discord] role sync after linking failed", error);
		}

		return back(c, "linked");
	})

	.post("/unlink", requireAuth, async (c) => {
		await unlinkAccount(c.get("user").id);
		return c.json({ ok: true });
	});
