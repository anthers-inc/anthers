// SPDX-License-Identifier: Apache-2.0
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
import { users, works } from "@anthers/db/schema";
import { extractPdsUrl } from "@atproto/oauth-client";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
	CREATOR_COLLECTIONS,
	EMAIL_SCOPE,
	getAtprotoClient,
	grantedScopeFor,
} from "./atproto-client.js";
import { scopeAllowsWriting } from "./atproto-scope.js";

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
 * The domain the old ATProto placeholder address sat on.
 *
 * `.invalid` is reserved by RFC 2606 precisely so that it can never resolve, which made
 * the placeholder honest: it was not a mailbox we failed to reach, it was a mailbox that
 * could not exist.
 *
 * ⚠️ **Nothing writes one any more** — the ceremony below never creates an account without
 * a real address. It is still read, because rows created before the ceremony existed are
 * still rows, and the unlink guard has to keep recognizing them.
 */
const PLACEHOLDER_EMAIL_DOMAIN = "atproto.invalid";

/** Whether an account has an address a sign-in code could actually arrive at. */
export function hasReachableEmail(email: string | null | undefined): boolean {
	return !!email && !email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * Whether Anthers is currently ASKING creators for permission to publish their listings.
 *
 * 🚨 **It gates asking, never using.** A permission already granted goes on working with this
 * off, because the alternative is that turning a switch off strands every record already on the
 * network — Anthers would be holding a permission it declined to use, on listings it could no
 * longer withdraw. Closing the door is about who walks through it next, and it is also why a
 * creator without the permission is only refused while this is open: closed, there is nothing
 * they could press.
 *
 * ⚠️ **The switch exists because the scope works and is not yet advertised.** bsky.social
 * honors a `repo:` permission today and does not list it in its published metadata, with
 * guidance to hold off shipping production changes until more is documented. Building against
 * it is a bet worth having ready; taking the bet in front of real creators is a separate
 * decision, and this is where that decision is made.
 */
export function atprotoPublishEnabled(): boolean {
	return process.env.ATPROTO_PUBLISH_ENABLED === "true";
}

// ─── Publishing a creator's listings into their own repository ───────────────

/** How a creator's records reach the network. */
export type PublishingRoute =
	/** Anthers hosts the identity and holds its credential. Nothing to grant. */
	| "hosted"
	/** They hold their identity elsewhere and have granted Anthers permission to publish. */
	| "granted"
	/**
	 * They hold their identity elsewhere and Anthers holds no permission covering their records,
	 * because they declined it, took it back, or it stopped working. Nothing they create can be
	 * published until they give it again.
	 */
	| "ungranted"
	/** No such account. Every account holds an identity, so this is never a state an account is in. */
	| "none";

export interface PublishingState {
	route: PublishingRoute;
	/** Whether Anthers is asking for the grant at all right now. */
	offered: boolean;
	/** The identity a listing would be published into, or null when there is none. */
	did: string | null;
	/** The handle a listing would be published under, for saying it out loud. */
	handle: string;
	/** How many of this creator's Works currently carry a listing on the network. */
	listed: number;
}

/** Which route an account's records take, and the identity they take it into. */
async function publishingRouteFor(
	userId: number,
): Promise<{ route: PublishingRoute; did: string | null; handle: string }> {
	const [user] = await db
		.select({ did: users.atprotoDid, handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user?.did) return { route: "none", did: null, handle: "" };
	const did = user.did;
	const handle = user.handle ?? "";

	// Imported here rather than at the top: `hosted-accounts.ts` reaches back into this module,
	// and a static edge in both directions is a cycle.
	const { isHostedIdentity } = await import("./hosted-accounts.js");
	if (await isHostedIdentity(did)) return { route: "hosted", did, handle };

	const granted = grantCoversCreatorRecords(await grantedScopeFor(did));
	return { route: granted ? "granted" : "ungranted", did, handle };
}

/**
 * What the Studio should say about publishing, for one account.
 *
 * 🚨 **`ungranted` is a problem to warn about, never an offer.** An identity Anthers can write
 * to is mandatory (Parker, 2026-09-12), so a creator in this state cannot publish anything, and
 * {@link publishingPermissionRefusal} refuses them. Everything that renders it owes a warning
 * and the one button that fixes it — the banner at the top of the site, the Studio settings
 * card, and the publish controls, which all read this.
 *
 * ⭐ **`recheck` asks the creator's authorization server whether a grant on file still holds.**
 * The stored scope only changes when something tries to use it, so a creator who took the
 * permission back at their own server would otherwise read as granted until their next release
 * was refused — the frustration the banner exists to head off. See `recheckPublishingGrant`.
 */
export async function publishingStateFor(
	userId: number,
	opts: { recheck?: boolean } = {},
): Promise<PublishingState> {
	let found = await publishingRouteFor(userId);
	if (opts.recheck && found.route === "granted" && found.did) {
		// Imported here for the same cycle reason as `hosted-accounts.ts` above.
		const { recheckPublishingGrant } = await import("./oauth-repo-writer.js");
		await recheckPublishingGrant(found.did);
		// Read again whatever the recheck said. A refused refresh deletes the stored session
		// inside the SDK, and a narrower grant is recorded without being "gone", so either can
		// change the answer without the recheck reporting it.
		found = await publishingRouteFor(userId);
	}
	return {
		...found,
		offered: atprotoPublishEnabled(),
		listed: await countListedWorks(userId),
	};
}

/** Why a creator may not publish until Anthers can write their records, ready to send. */
export interface PublishingPermissionRefusal {
	status: 409;
	body: { error: string; code: "publishing_permission_required" };
}

/**
 * Whether this creator must give Anthers permission over their repository before publishing.
 *
 * 🚨 **Releasing a Work, publishing a post and publishing a project all write a record into the
 * creator's own repository, and with no permission to write it the release is a lie.** The Work
 * would go out on Anthers and never reach the network, and nothing would say so. An identity
 * Anthers can write to is mandatory (Parker, 2026-09-12), so this is a refusal beside payout
 * setup rather than a skipped listing. `publishRefusal` asks it, which is how every publishing
 * path gets it.
 *
 * ⚠️ **Refused only while Anthers is asking for the permission.** With `ATPROTO_PUBLISH_ENABLED`
 * closed there is no button that could give it, and a refusal nobody can act on is a creator
 * locked out rather than warned.
 *
 * ⚠️ **It reads what is on file and never calls anybody's server.** An authorization server
 * that is down is not a lapsed grant — the listing waits and retries, and a creator's release
 * must never depend on the uptime of a machine they may not run. Only an answer that the
 * permission is gone changes what is on file.
 */
export async function publishingPermissionRefusal(
	userId: number,
	act: "release" | "publish",
): Promise<PublishingPermissionRefusal | null> {
	if (!atprotoPublishEnabled()) return null;
	const { route, handle } = await publishingRouteFor(userId);
	if (route !== "ungranted") return null;
	const where = handle ? `your repository at @${handle}` : "your repository";
	return {
		status: 409,
		body: {
			error: `Anthers doesn't have your permission to publish to ${where}, so it can't ${act} anything for you. Give it under Studio settings and you'll be able to ${act} straight away.`,
			code: "publishing_permission_required",
		},
	};
}

/**
 * Take in what a creator granted at the consent screen, and act on it.
 *
 * 🚨 **The identity that came back is checked against the one on the account.** Nothing stops
 * somebody starting this flow signed in as themselves and authorizing as a different Bluesky
 * account, and accepting that would leave Anthers writing one person's catalog into another
 * person's repository. The DID is the identity; the handle is not.
 *
 * ⚠️ **A decline leaves the creator unable to publish**, exactly as a permission that lapsed
 * would, and is reported to them as that rather than as an error. Nothing is recorded as
 * broken, because nothing is: they said no, and the Studio says what that means.
 */
export type PublishGrantResult =
	| { status: "granted"; queued: number }
	| { status: "declined" }
	| { status: "refused"; reason: "not_linked" | "wrong_identity" | "hosted" };

export async function recordPublishGrant(
	userId: number,
	identity: AtprotoIdentity,
	grantedScope: string | null,
): Promise<PublishGrantResult> {
	const [user] = await db
		.select({ did: users.atprotoDid })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!user?.did) return { status: "refused", reason: "not_linked" };
	if (user.did !== identity.did) return { status: "refused", reason: "wrong_identity" };

	const { isHostedIdentity } = await import("./hosted-accounts.js");
	if (await isHostedIdentity(user.did)) return { status: "refused", reason: "hosted" };

	if (!grantCoversCreatorRecords(grantedScope)) return { status: "declined" };

	// ⭐ Their catalog, not just whatever they release next — Works, posts and projects alike.
	// Imported here because `work-listing.ts` reaches the hosted writer, which reaches
	// `hosted-accounts.ts`, which reaches back into this module — a cycle if imported statically.
	const { queueAllListingsFor } = await import("./work-listing.js");
	const { queueAllCreatorRecordsFor } = await import("./creator-record-listing.js");
	const queued = (await queueAllListingsFor(userId)) + (await queueAllCreatorRecordsFor(userId));
	return { status: "granted", queued };
}

/** How many of this creator's Works are currently listed on the network. */
async function countListedWorks(creatorId: number): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(works)
		.where(and(eq(works.creatorId, creatorId), isNotNull(works.atprotoUri)));
	return row?.count ?? 0;
}

/*
 * 🚨 **There is deliberately no `createAccountFromAtproto` here, and putting one back would
 * undo a security decision** (Parker, 2026-08-22). One existed until then: it created an
 * account outright when the PDS reported `emailConfirmed: true`, skipping Anthers' own
 * verification. The party being trusted was **whichever server the person's identity lives
 * on**, so anyone self-hosting a PDS could claim an address they do not control.
 *
 * Every signup ends after a code we sent has been read, and the account is created there, with
 * the identity `establishSignupIdentity` in `services/pending-signups.ts` settled first, by
 * `mintFromProvedAddress` in `routes/auth.ts`. That is the ONLY place an account comes into
 * existence.
 */

/**
 * Whether the account behind this handle or DID publishes, and therefore needs the creator
 * permission asked for again on the way in.
 *
 * ⚠️ **Answers false for anything it cannot resolve, and that is safe in the right
 * direction.** A handle nobody has linked, a typo, or a directory having a bad moment all mean
 * "ask for the base set" — and the authorization the SDK is about to attempt will fail on its
 * own terms with a message somebody can act on. The failure this avoids is asking a stranger
 * for a permission over their repository because their handle did not resolve.
 */
/**
 * Whether this Anthers account publishes.
 *
 * ⚠️ **Asked by id rather than by identity, which is the whole point of it existing.** Linking
 * happens *before* there is a DID on the account, so the identity-shaped question has no answer
 * yet and the account-shaped one already does.
 */
export async function isCreatorAccount(userId: number): Promise<boolean> {
	const [row] = await db
		.select({ isCreator: users.isCreator })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row?.isCreator === true;
}

export async function isCreatorIdentity(didOrHandle: string): Promise<boolean> {
	try {
		const did = didOrHandle.startsWith("did:")
			? didOrHandle
			: (await resolveIdentity(didOrHandle)).did;
		const [row] = await db
			.select({ isCreator: users.isCreator })
			.from(users)
			.where(eq(users.atprotoDid, did))
			.limit(1);
		return row?.isCreator === true;
	} catch {
		return false;
	}
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

// ─── Reading the address the PDS holds ───────────────────────────────────────

/** What the PDS says about this account's email, and whether it was willing to say. */
export interface PdsEmail {
	/** The address, if the scope was granted and the PDS holds one. */
	email?: string;
	/**
	 * Whether the **PDS** says it has verified the address.
	 *
	 * 🚨 **Reported, and deliberately not trusted.** This gated a shortcut until 2026-08-22:
	 * `confirmed: true` created the account outright and skipped Anthers' own verification.
	 * The server making the claim is whichever one the person's identity lives on, so a
	 * self-hosted PDS could assert any address at all. Every signup is verified by our own
	 * emailed code now, and **nothing may read this field to decide otherwise** — a test in
	 * `atproto-signup.test.ts` pins that a `confirmed: true` answer still parks the signup.
	 */
	confirmed: boolean;
	/** Whether `transition:email` was actually granted, as opposed to merely requested. */
	scopeGranted: boolean;
}

/**
 * Ask the PDS for the account's email address, to save somebody typing it.
 *
 * ⚠️ **This is a convenience and never evidence.** Whatever comes back becomes a prefill on
 * `/subscribe`, and the emailed code is what makes it true — see `confirmed` above for the
 * shortcut this used to have and why it is gone.
 *
 * ⭐ **The granted scope is read from the token rather than assumed from the request.**
 * `getTokenInfo().scope` carries what the authorization server actually issued, so an
 * authorization screen that lets someone decline `transition:email` — which nobody has yet
 * confirmed bsky.social does, one way or the other — is detected rather than guessed at.
 *
 * ⚠️ It is also a read at a moment, not a subscription: an address changed at the PDS
 * afterwards never reaches us.
 *
 * Every failure is soft. A PDS that is down, a scope that was refused and an account with
 * no address on file all mean the same thing — an empty field instead of a filled one.
 */
export async function readPdsEmail(session: {
	getTokenInfo: () => Promise<{ scope?: string }>;
	fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>;
}): Promise<PdsEmail> {
	try {
		const { scope } = await session.getTokenInfo();
		const scopeGranted = (scope ?? "").split(/\s+/).includes(EMAIL_SCOPE);
		if (!scopeGranted) return { confirmed: false, scopeGranted: false };

		const res = await session.fetchHandler("/xrpc/com.atproto.server.getSession");
		if (!res.ok) return { confirmed: false, scopeGranted: true };

		const body = (await res.json()) as { email?: string; emailConfirmed?: boolean };
		return {
			email: body.email?.trim() || undefined,
			confirmed: body.emailConfirmed === true,
			scopeGranted: true,
		};
	} catch {
		return { confirmed: false, scopeGranted: false };
	}
}

// ─── Signups waiting on an address ───────────────────────────────────────────
//
// Unfinished signups live in `services/pending-signups.ts`, the only writer of those records.
// It carries the rules about what may be carried across from an unfinished signup — including
// the one that stops an address-resumed row handing over an identity nobody re-proved — and
// settles a new account's identity before the account exists.

/**
 * Whether a granted scope lets Anthers keep a creator's whole catalog.
 *
 * 🚨 **Every creator collection, not Work listings alone.** A grant covering Works and not posts
 * would read as publishing being on while every post quietly failed to go out, so anything short
 * of the whole set is the state a creator can still act on — asked again — rather than a working
 * state with a hole in it. A grant made under the retired catalog set covers Works alone, and is
 * correctly reported as needing to be asked again.
 */
function grantCoversCreatorRecords(scope: string | null | undefined): boolean {
	return CREATOR_COLLECTIONS.every((collection) => scopeAllowsWriting(scope, collection));
}
