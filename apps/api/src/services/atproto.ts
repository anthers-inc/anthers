// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ATProto identity as it touches Anthers accounts.
 *
 * The OAuth protocol machinery lives in `atproto-client.ts` and comes from the official
 * SDK. What remains here is the part that is genuinely ours: mapping a DID to an Anthers
 * account, and the rules about when that mapping may be created, changed or removed.
 *
 * This file used to be 605 lines, most of it a hand-rolled implementation of DPoP, PKCE,
 * PAR, handle resolution and DID resolution. All of that is now the SDK's.
 */
import { db } from "@anthers/db";
import { atprotoSessions, users } from "@anthers/db/schema";
import { extractPdsUrl } from "@atproto/oauth-client";
import { eq } from "drizzle-orm";
import { getAtprotoClient } from "./atproto-client.js";

export interface AtprotoIdentity {
	did: string;
	handle: string;
	pdsUrl: string;
}

/**
 * Resolve a DID (or handle) to the identity fields Anthers stores. Used after the OAuth
 * callback, which hands back only a DID.
 *
 * The handle is a *claim* the DID document makes and the SDK verifies bidirectionally
 * during resolution, so it is safe to store — but it changes over time, which is why the
 * DID and not the handle is the identity column.
 */
export async function resolveIdentity(didOrHandle: string): Promise<AtprotoIdentity> {
	const resolved = await getAtprotoClient().identityResolver.resolve(didOrHandle);
	return {
		did: resolved.did,
		// ⚠️ The resolver returns the literal `handle.invalid` when the handle does not
		// resolve back to the same DID — an unverified claim, not a handle. Storing it would
		// put a fake domain on the profile and in every `@mention` we ever render, so it is
		// treated as absent. The DID is unaffected and remains the identity.
		handle: resolved.handle === HANDLE_INVALID ? "" : resolved.handle,
		pdsUrl: pdsUrlOf(resolved.didDoc),
	};
}

/** The resolver's sentinel for a handle that failed bidirectional verification. */
const HANDLE_INVALID = "handle.invalid";

/**
 * ⚠️ `extractPdsUrl` THROWS on a document with no `#atproto_pds` service; it does not
 * return undefined. A DID that resolves but hosts no repository is a real state — a
 * deactivated or mid-migration account — and letting it throw would turn "this account has
 * no PDS right now" into a failed sign-in.
 */
function pdsUrlOf(didDoc: Parameters<typeof extractPdsUrl>[0]): string {
	try {
		return extractPdsUrl(didDoc).toString();
	} catch {
		return "";
	}
}

/** Fetch a user's Bluesky profile (public, no auth needed). Best-effort decoration only. */
export async function getBlueskyProfile(
	did: string,
): Promise<{ displayName?: string; avatar?: string }> {
	try {
		const res = await fetch(
			`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
		);
		if (res.ok) {
			const data = (await res.json()) as { displayName?: string; avatar?: string };
			return { displayName: data.displayName, avatar: data.avatar };
		}
	} catch {
		// Non-fatal: a missing profile must never fail a sign-in.
	}
	return {};
}

// ─── ATProto ↔ Anthers account mapping ───────────────────────────────────────

/**
 * The domain an ATProto-created account's placeholder address sits on.
 *
 * `.invalid` is reserved by RFC 2606 precisely so that it can never resolve, which makes
 * the placeholder honest: it is not a mailbox we failed to reach, it is a mailbox that
 * cannot exist. One constant because two functions care — the one that writes it and the
 * one that has to notice an account cannot be mailed.
 */
const PLACEHOLDER_EMAIL_DOMAIN = "atproto.invalid";

/** Whether an account has an address a sign-in code could actually arrive at. */
export function hasReachableEmail(email: string | null | undefined): boolean {
	return !!email && !email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * Create an Anthers account from an ATProto identity.
 *
 * 🚨 This is a SIGNUP, and it is gated. It previously ran unconditionally from a public,
 * unauthenticated endpoint, minting an account with a generated username and a placeholder
 * `{did}@atproto.invalid` address — bypassing the emailed verification code, the payment
 * step, onboarding, and the join gate. Two canonical documents stated that ATProto OAuth
 * "cannot create an account", which was true of the user interface and false of the API:
 * nothing in the UI called it, and that was the only thing holding the door shut.
 *
 * ATProto signup is wanted now rather than merely tolerated, so the resolution is a real
 * ceremony rather than a deletion — but a ceremony is a build, and until it exists this
 * path stays closed. `ATPROTO_SIGNUP_ENABLED` is the deliberate opener, off by default.
 */
export async function createUserFromAtproto(
	identity: AtprotoIdentity,
	displayName?: string,
): Promise<{ user?: typeof users.$inferSelect; error?: string }> {
	if (process.env.ATPROTO_SIGNUP_ENABLED !== "true") {
		return { error: "signup_disabled" };
	}
	const username = await generateUniqueUsername(identity.handle);
	const [user] = await db
		.insert(users)
		.values({
			username,
			// ⚠️ A placeholder address, and the reason the ceremony is owed: this account has
			// no reachable email, so it cannot be verified, recovered, or notified.
			email: `${identity.did}@${PLACEHOLDER_EMAIL_DOMAIN}`,
			atprotoDid: identity.did,
			atprotoHandle: identity.handle,
			atprotoPdsUrl: identity.pdsUrl,
			displayName: displayName ?? "",
			emailVerified: false,
		})
		.returning();
	return { user };
}

/** Find the Anthers account already bound to a DID, refreshing its handle and PDS. */
export async function findUserByAtprotoDid(
	identity: AtprotoIdentity,
	displayName?: string,
): Promise<typeof users.$inferSelect | undefined> {
	const [existing] = await db
		.select()
		.from(users)
		.where(eq(users.atprotoDid, identity.did))
		.limit(1);
	if (!existing) return undefined;

	// A handle can change under a stable DID, so reconcile rather than skip — the same
	// argument the dev-account bootstrap makes for reconciling instead of create-if-missing.
	const updates: Record<string, string> = {};
	if (existing.atprotoHandle !== identity.handle) updates.atprotoHandle = identity.handle;
	if (existing.atprotoPdsUrl !== identity.pdsUrl) updates.atprotoPdsUrl = identity.pdsUrl;
	if (displayName && !existing.displayName) updates.displayName = displayName;
	if (Object.keys(updates).length > 0) {
		await db.update(users).set(updates).where(eq(users.id, existing.id));
	}
	return { ...existing, ...updates };
}

/** Generate a unique username from an ATProto handle. */
async function generateUniqueUsername(handle: string): Promise<string> {
	let base = handle
		.replace(/\.bsky\.social$/, "")
		.replace(/\.bsky\.network$/, "")
		.replace(/\.bsky\.app$/, "");
	base = base.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30);
	if (!base) base = "user";

	const [exists] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, base))
		.limit(1);
	if (!exists) return base;

	for (let i = 1; i <= 999; i++) {
		const candidate = `${base.slice(0, 26)}-${i}`;
		const [taken] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, candidate))
			.limit(1);
		if (!taken) return candidate;
	}
	return `user-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Link an ATProto DID to an existing user account.
 *
 * ⚠️ **The refusal is a code rather than a sentence, and the two are not interchangeable
 * here.** This one is reached through the OAuth callback, so it travels back to the browser
 * as a query parameter and is turned into words by `ATProtoCallbackPage`. It read as a
 * sentence until 2026-08-22, which meant the page's `did_already_linked` message was dead
 * code that could never match — the raw sentence happened to be readable, so nothing ever
 * looked wrong. Errors that do *not* round-trip stay sentences; see `unlinkAtprotoFromUser`.
 */
export async function linkAtprotoToUser(
	userId: number,
	identity: AtprotoIdentity,
): Promise<{ error?: string }> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoDid, identity.did))
		.limit(1);

	if (existing && existing.id !== userId) {
		return { error: "did_already_linked" };
	}

	await db
		.update(users)
		.set({
			atprotoDid: identity.did,
			atprotoHandle: identity.handle,
			atprotoPdsUrl: identity.pdsUrl,
		})
		.where(eq(users.id, userId));

	return {};
}

/**
 * Unlink ATProto from a user. Refuses when doing so would leave no way back in.
 *
 * 🚨 **"No way back in" is not the same as "no password", and reading it that way locked
 * out accounts that were fine** (fixed 2026-08-22). A password has been optional since the
 * signup ceremony shipped: `/auth/signin/start` mails a six-character code to any address
 * that has an account, whatever it holds for a password. So the check that matters is
 * whether the account has a **reachable address**, and the only unreachable one Anthers
 * ever writes is the `@atproto.invalid` placeholder an ATProto-created account gets. The
 * old check refused every passwordless account, which is most of them now — a guard aimed
 * at the ATProto-only case that had quietly grown to cover the ordinary one.
 *
 * The refusal is a sentence rather than a code because it is answered as JSON to a page
 * that displays it; nothing about it survives a redirect. Contrast `linkAtprotoToUser`.
 */
export async function unlinkAtprotoFromUser(userId: number): Promise<{ error?: string }> {
	const [user] = await db
		.select({
			passwordHash: users.passwordHash,
			email: users.email,
			atprotoDid: users.atprotoDid,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user) {
		return { error: "Account not found" };
	}

	if (!user.passwordHash && !hasReachableEmail(user.email)) {
		return {
			error:
				"Unlinking would leave no way to sign in — this account has no password and no email address we can reach.",
		};
	}

	await db
		.update(users)
		.set({ atprotoDid: null, atprotoHandle: "", atprotoPdsUrl: "" })
		.where(eq(users.id, userId));

	// Revoke at the authorization server as well as locally. A row deleted without a
	// revocation leaves a live token we no longer track, which is the worse of the two.
	if (user.atprotoDid) {
		try {
			await getAtprotoClient().revoke(user.atprotoDid);
		} catch {
			// The server may already consider it gone; the local delete below is what matters.
		}
		await db.delete(atprotoSessions).where(eq(atprotoSessions.did, user.atprotoDid));
	}
	await db.delete(atprotoSessions).where(eq(atprotoSessions.userId, userId));

	return {};
}
