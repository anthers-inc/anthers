// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ATProto OAuth routes.
 *
 * Endpoints:
 *   GET  /client-metadata.json — OAuth client metadata document
 *   POST /auth                 — Initiate OAuth flow (returns authorization URL)
 *   GET  /callback             — OAuth callback (exchanges code, creates session, redirects)
 *   POST /unlink               — Unlink ATProto identity from account
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { OAuthInitResult } from "../services/atproto.js";
import {
	exchangeCode,
	findOrCreateAtprotoUser,
	getBlueskyProfile,
	initiateOAuth,
	linkAtprotoToUser,
	saveAtprotoSession,
	unlinkAtprotoFromUser,
} from "../services/atproto.js";
import { createSession, validateSession } from "../services/auth.js";

// ─── OAuth State Store ───────────────────────────────────────────────────────
// In-memory store for OAuth state between init and callback.
// In production, this should be backed by Redis with TTL.

interface OAuthState extends OAuthInitResult {
	intent: "login" | "link";
	userId?: number; // set when intent === "link"
	createdAt: number;
}

const oauthStateStore = new Map<string, OAuthState>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanExpiredStates() {
	const now = Date.now();
	for (const [key, value] of oauthStateStore) {
		if (now - value.createdAt > STATE_TTL_MS) {
			oauthStateStore.delete(key);
		}
	}
}

// Clean expired states every 5 minutes
setInterval(cleanExpiredStates, 5 * 60 * 1000);

// ─── Schemas ─────────────────────────────────────────────────────────────────

const authInitSchema = z.object({
	handle: z.string().min(1),
	intent: z.enum(["login", "link"]).default("login"),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
	return process.env.BASE_URL ?? "http://localhost:8000";
}

function getFrontendUrl(): string {
	return process.env.FRONTEND_URL ?? "http://localhost:3000";
}

function setSessionCookie(c: any, token: string) {
	setCookie(c, "session", token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
		path: "/",
		maxAge: 30 * 24 * 60 * 60,
	});
}

const atprotoRoutes = new Hono()
	// ── Client Metadata ──────────────────────────────────────────────────────
	.get("/client-metadata.json", (c) => {
		const baseUrl = getBaseUrl();
		const clientId = process.env.ATPROTO_CLIENT_ID ?? `${baseUrl}/api/atproto/client-metadata.json`;
		const redirectUri = `${baseUrl}/api/atproto/callback`;

		return c.json({
			client_id: clientId,
			client_name: "Anthers",
			client_uri: baseUrl,
			redirect_uris: [redirectUri],
			scope: "atproto",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			application_type: "web",
			dpop_bound_access_tokens: true,
		});
	})

	// ── Auth Init ────────────────────────────────────────────────────────────
	.post("/auth", zValidator("json", authInitSchema), async (c) => {
		const { handle, intent } = c.req.valid("json");

		// If linking, user must be authenticated
		let userId: number | undefined;
		if (intent === "link") {
			const token = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
			if (!token) {
				return c.json({ error: "Authentication required for linking" }, 401);
			}
			const result = await validateSession(token);
			if (!result) {
				return c.json({ error: "Invalid session" }, 401);
			}
			userId = result.user.id;
		}

		const baseUrl = getBaseUrl();
		const clientId = process.env.ATPROTO_CLIENT_ID ?? undefined;
		const redirectUri = `${baseUrl}/api/atproto/callback`;

		try {
			const oauthResult = await initiateOAuth({
				handle,
				clientId,
				redirectUri,
				baseUrl,
			});

			// Store state for callback
			oauthStateStore.set(oauthResult.state, {
				...oauthResult,
				intent,
				userId,
				createdAt: Date.now(),
			});

			return c.json({ authorization_url: oauthResult.authorizationUrl });
		} catch (err) {
			const message = err instanceof Error ? err.message : "OAuth initiation failed";
			return c.json({ error: message }, 400);
		}
	})

	// ── Callback ─────────────────────────────────────────────────────────────
	.get("/callback", async (c) => {
		const frontendUrl = getFrontendUrl();
		const callbackUrl = `${frontendUrl}/auth/atproto/callback`;

		// Check for errors from AS
		const error = c.req.query("error");
		if (error) {
			const desc = c.req.query("error_description") ?? error;
			return c.redirect(`${callbackUrl}?error=${encodeURIComponent(desc)}`);
		}

		const code = c.req.query("code");
		const state = c.req.query("state");
		const iss = c.req.query("iss");

		if (!code || !state) {
			return c.redirect(`${callbackUrl}?error=missing_params`);
		}

		// Look up stored state
		const storedState = oauthStateStore.get(state);
		if (!storedState) {
			return c.redirect(`${callbackUrl}?error=session_expired`);
		}

		// Clean up state immediately
		oauthStateStore.delete(state);

		// Check expiry
		if (Date.now() - storedState.createdAt > STATE_TTL_MS) {
			return c.redirect(`${callbackUrl}?error=session_expired`);
		}

		try {
			// Exchange code for tokens
			const tokenData = await exchangeCode(
				storedState.asMetadata.token_endpoint,
				code,
				storedState.redirectUri,
				storedState.codeVerifier,
				storedState.clientId,
				storedState.dpopPrivatePem,
				storedState.dpopJwk,
			);

			// Fetch Bluesky profile for display name
			const profile = await getBlueskyProfile(tokenData.sub);

			if (storedState.intent === "link") {
				// ── Link intent ──────────────────────────────────────────
				if (!storedState.userId) {
					return c.redirect(`${callbackUrl}?error=not_authenticated`);
				}

				const linkResult = await linkAtprotoToUser(
					storedState.userId,
					tokenData.sub,
					storedState.handle,
					storedState.pdsUrl,
				);

				if (linkResult.error) {
					return c.redirect(`${callbackUrl}?error=${encodeURIComponent(linkResult.error)}`);
				}

				// Save ATProto session tokens
				await saveAtprotoSession(
					storedState.userId,
					tokenData,
					storedState.dpopPrivatePem,
					storedState.dpopJwk,
					storedState.asMetadata.token_endpoint,
				);

				return c.redirect(`${callbackUrl}?success=linked`);
			}

			// ── Login intent ─────────────────────────────────────────────
			const user = await findOrCreateAtprotoUser(
				tokenData.sub,
				storedState.handle,
				storedState.pdsUrl,
				profile.displayName,
			);

			// Save ATProto session tokens
			await saveAtprotoSession(
				user.id,
				tokenData,
				storedState.dpopPrivatePem,
				storedState.dpopJwk,
				storedState.asMetadata.token_endpoint,
			);

			// Create app session
			const sessionToken = await createSession(
				user.id,
				c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
				c.req.header("User-Agent"),
			);
			setSessionCookie(c, sessionToken);

			return c.redirect(`${callbackUrl}?success=login`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "exchange_failed";
			return c.redirect(`${callbackUrl}?error=${encodeURIComponent(message)}`);
		}
	})

	// ── Unlink ───────────────────────────────────────────────────────────────
	.post("/unlink", requireAuth, async (c) => {
		const user = c.get("user");
		const result = await unlinkAtprotoFromUser(user.id);

		if (result.error) {
			return c.json({ error: result.error }, 400);
		}

		return c.json({ success: true });
	});

export { atprotoRoutes };
