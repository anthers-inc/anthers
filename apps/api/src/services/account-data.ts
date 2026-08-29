// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Everything Anthers holds about one person, assembled in one place — the engine
 * behind the **export** half of the Privacy Policy's rights section.
 *
 * Article I(c) of the Articles commits the corporation to advancing individuals'
 * ability to *own, access, and control* what they create, and the Privacy Policy turns "access"
 * into a promise of *"a copy of your information and your content, in an openly
 * readable format."* This is the module that has to be able to answer it.
 *
 * Four rules shape what comes out, and three of them are about what does NOT:
 *
 * 1. **JSON, and no proprietary container.** The charter's open-formats clause argues
 *    for something any tool can read, and the Obsidian analogy Parker uses about other
 *    people's software applies to ours: a copy you can only open with the thing you're
 *    leaving is not a copy. Media files are referenced by URL rather than inlined —
 *    inlining would put base64 blobs in a document meant to be readable, and the URLs
 *    are re-resolved against live access when followed.
 *
 * 2. 🚨 **No secrets, ever.** `password_hash`, session tokens, ATProto access and
 *    refresh tokens and the DPoP private key are all *about* the user and none of them
 *    belong in a file they will email to themselves. An export is a credential-shaped
 *    hazard by default: it is the one document containing everything, and it leaves our
 *    control the moment it is generated. Sessions appear as metadata only — when, from
 *    where, what device — which is what the Devices list already shows them.
 *
 * 3. **Other people's data stays out, including where it is also theirs.** A report
 *    somebody filed *about* this user is personal data about them and would ordinarily
 *    be in scope, but disclosing it identifies the reporter — GDPR Art. 15(4) and its
 *    equivalents exist for exactly this, and the moderation model's open question about
 *    not exposing reporters points the same way. Reports the user *filed* are theirs
 *    and are included. Comments by other people on the user's Works are those people's
 *    words, so only the user's own are exported.
 *
 * 4. **It is a snapshot, and it says so.** Nothing here is a live feed; the payload
 *    carries the moment it was taken so a stale copy can be recognised as one.
 *
 * The same assembly is what makes deletion honest, which is why this module is
 * `account-data` rather than `export`: you cannot credibly promise to delete what you
 * cannot enumerate, and having one list means the two answers can't drift.
 */

import { db } from "@anthers/db/client";
import {
	accountCycles,
	accounts,
	attentionEvents,
	bookmarks,
	comments,
	creatorGates,
	crfSubsidies,
	follows,
	moderationReports,
	poolDistributions,
	posts,
	projects,
	purchases,
	ratings,
	seedAllocations,
	sessions,
	stripeAccounts,
	userBlocks,
	users,
	works,
} from "@anthers/db/schema";
import { eq } from "drizzle-orm";

/** Bump when the shape changes in a way a consumer would notice. */
export const EXPORT_FORMAT_VERSION = 1;

export interface AccountExport {
	format: string;
	formatVersion: number;
	generatedAt: string;
	notes: string[];
	[section: string]: unknown;
}

/**
 * Assemble the full export for one user.
 *
 * Deliberately synchronous rather than a queued job that emails a link. A personal
 * archive here is kilobytes — a few hundred rows and no media bytes — and a job would
 * add a queue, a storage object, an expiring URL and a notification path the app does
 * not have (Privacy Policy marker 8). If exports ever grow past what a request can serve, that
 * is the moment to move it, and `notes` already tells the reader what isn't inlined.
 */
export async function buildAccountExport(userId: number): Promise<AccountExport | null> {
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user) return null;

	const [
		sessionRows,
		followingRows,
		followerRows,
		blockRows,
		bookmarkRows,
		commentRows,
		ratingRows,
		postRows,
		workRows,
		projectRows,
		purchaseRows,
		accountRow,
		cycleRows,
		attentionRows,
		seedRows,
		distributionRows,
		gateRows,
		reportRows,
		subsidyRows,
		stripeRow,
	] = await Promise.all([
		db.select().from(sessions).where(eq(sessions.userId, userId)),
		db.select().from(follows).where(eq(follows.followerId, userId)),
		db.select().from(follows).where(eq(follows.creatorId, userId)),
		db.select().from(userBlocks).where(eq(userBlocks.blockerId, userId)),
		db.select().from(bookmarks).where(eq(bookmarks.userId, userId)),
		db.select().from(comments).where(eq(comments.userId, userId)),
		db.select().from(ratings).where(eq(ratings.userId, userId)),
		db.select().from(posts).where(eq(posts.creatorId, userId)),
		db.select().from(works).where(eq(works.creatorId, userId)),
		db.select().from(projects).where(eq(projects.creatorId, userId)),
		db.select().from(purchases).where(eq(purchases.buyerId, userId)),
		db.select().from(accounts).where(eq(accounts.userId, userId)),
		db.select().from(accountCycles).where(eq(accountCycles.userId, userId)),
		db.select().from(attentionEvents).where(eq(attentionEvents.userId, userId)),
		db.select().from(seedAllocations).where(eq(seedAllocations.userId, userId)),
		db.select().from(poolDistributions).where(eq(poolDistributions.subscriberId, userId)),
		db.select().from(creatorGates).where(eq(creatorGates.creatorId, userId)),
		db.select().from(moderationReports).where(eq(moderationReports.reporterId, userId)),
		db.select().from(crfSubsidies).where(eq(crfSubsidies.creatorId, userId)),
		db.select().from(stripeAccounts).where(eq(stripeAccounts.userId, userId)),
	]);

	return {
		format: "anthers-account-export",
		formatVersion: EXPORT_FORMAT_VERSION,
		generatedAt: new Date().toISOString(),
		notes: [
			"This is a snapshot taken at generatedAt, not a live feed.",
			"Credentials are deliberately excluded: your password hash, session tokens, and any linked-identity tokens are not in this file. Nothing here can be used to sign in as you.",
			"Media files are referenced by URL rather than embedded. Follow a URL while signed in to download the file itself.",
			"Reports that other people filed about you are not included, because they would identify the person who filed them. Reports YOU filed are included.",
			"Comments and reviews other people left on your work are their words, not yours, and are not included here.",
			"Your viewing history covers only the period we still hold it for — older records have been aggregated into per-Work totals and the per-person rows deleted. See the Privacy Policy on retention.",
		],

		profile: {
			id: user.id,
			username: user.username,
			email: user.email,
			displayName: user.displayName,
			bio: user.bio,
			avatar: user.avatar,
			headerImage: user.headerImage,
			websiteUrl: user.websiteUrl,
			location: user.location,
			isCreator: user.isCreator,
			emailVerified: user.emailVerified,
			themePreference: user.themePreference,
			createdAt: user.createdAt,
			// The DID and handle are public identifiers the user chose to link. The tokens
			// behind them are not here — see the note above.
			atprotoDid: user.atprotoDid,
			atprotoHandle: user.atprotoHandle,
			atprotoPdsUrl: user.atprotoPdsUrl,
		},

		// Metadata only, matching what Settings → Devices already shows. The `token`
		// column is the credential and never leaves the database.
		sessions: sessionRows.map((s) => ({
			kind: s.kind,
			label: s.label,
			ipAddress: s.ipAddress,
			userAgent: s.userAgent,
			lastUsedAt: s.lastUsedAt,
			expiresAt: s.expiresAt,
			createdAt: s.createdAt,
		})),

		social: {
			following: followingRows.map((f) => ({ creatorId: f.creatorId, createdAt: f.createdAt })),
			// Who follows you is a fact about your account as much as about them, and it is
			// already visible to you as a count. Ids only — no names, no emails.
			followers: followerRows.map((f) => ({ followerId: f.followerId, createdAt: f.createdAt })),
			blocked: blockRows.map((b) => ({ blockedId: b.blockedId, createdAt: b.createdAt })),
			bookmarks: bookmarkRows,
		},

		content: {
			posts: postRows,
			works: workRows,
			projects: projectRows,
			comments: commentRows,
			reviews: ratingRows,
		},

		money: {
			purchases: purchaseRows,
			account: accountRow[0] ?? null,
			cycles: cycleRows,
			seedAllocations: seedRows,
			poolDistributions: distributionRows,
			creatorGates: gateRows,
			// This account's own hosting-subsidy calculations, per cycle. Note `crf_ledger`
			// is deliberately NOT here: it is a platform-level ledger keyed on a purchase
			// with no user reference at all, so it is not personal data about anyone — the
			// purchase row it points at is what belongs to a person, and that is exported
			// above.
			hostingSubsidies: subsidyRows,
			// Connect account id and capability flags. The KYC documents behind them live
			// at Stripe and were never ours to hold — see the Privacy Policy on learning the predicate
			// rather than the data.
			stripeAccount: stripeRow[0] ?? null,
		},

		viewingHistory: attentionRows.map((e) => ({
			creatorId: e.creatorId,
			workId: e.workId,
			eventType: e.eventType,
			durationSeconds: e.durationSeconds,
			createdAt: e.createdAt,
		})),

		// What this user reported. Not what was reported about them.
		reportsYouFiled: reportRows.map((r) => ({
			subjectType: r.subjectType,
			subjectId: r.subjectId,
			reason: r.reason,
			details: r.details,
			status: r.status,
			createdAt: r.createdAt,
		})),
	};
}
