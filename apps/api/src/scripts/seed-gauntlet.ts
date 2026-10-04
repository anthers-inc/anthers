// SPDX-License-Identifier: Apache-2.0
/**
 * The User Gauntlet fixture — deterministic, idempotent, and self-cleaning.
 *
 * Builds `gauntlet_creator` and the nine posts defined in `gauntlet.ts`, then resets the
 * viewer to the gauntlet's floor: Free badge, nothing given, not following, nothing purchased,
 * no comments. Run it before every gauntlet walk; it always produces the same starting
 * state, which is the whole point — a gauntlet that starts somewhere slightly different
 * each time can't tell you what changed.
 *
 * Usage:
 *   bun run db:gauntlet                 # reset to the floor (make gauntlet-reset)
 *   bun run db:gauntlet --user alice    # use a viewer other than DEV_ACCOUNT_USERNAME
 *   bun run db:gauntlet --ensure-viewer # create + use the harness's own gauntlet_viewer
 *   bun run db:gauntlet --clean         # remove the fixture entirely, then stop
 *   bun run db:gauntlet --instance walk # the walk's OWN instance — see below
 *
 * The viewer defaults to your dev account (`DEV_ACCOUNT_USERNAME` in `.env`). Its rows are
 * *reset*, never deleted — the account itself, its password and its other content survive.
 * Only this fixture's own footprint (the `gauntlet_` creator + `gauntlet-` posts, and the
 * viewer's relationship to them) is touched.
 *
 * `--ensure-viewer` is the e2e harness's entry point: it creates the fixture-owned
 * `gauntlet_viewer` account if missing (email pre-verified, not a creator) and resets THAT
 * viewer — so the automated walk never touches the dev account, and works where no dev
 * account exists at all (CI).
 *
 * **Instances.** `--instance walk` seeds the walk's own copy of the fixture instead of the
 * shared one: the `walk-creator` / `walk-viewer` accounts and the `walk-gauntlet-` posts
 * defined in `gauntlet-walk.ts`. The e2e `authed` project runs on instance A (the
 * default), and the e2e `gauntlet` walk runs on instance B — both reset their own fixture
 * in their own setup, which is safe only because the two row sets are disjoint. The Anthers stand-in and the
 * Anthers Badge ladder are deliberately NOT per-instance: holdings are viewer-scoped
 * rows, and one shared Anthers ladder keeps every viewer's Anthers-side reads reading the
 * same ladder rather than a second, private one.
 *
 * Spec: the Anthers wiki, `70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	assets,
	attentionEvents,
	badges,
	comments,
	db,
	follows,
	poolDistributions,
	posts,
	postWorkRefs,
	purchases,
	stripeAccounts,
	userBadges,
	users,
	works,
} from "@anthers/db";
import { localContentRoot } from "@anthers/db/content-root";
import { assertDevCheckout } from "@anthers/db/dev-only";
import {
	GAUNTLET_BADGES,
	GAUNTLET_CREATOR_EMAIL,
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_ORG_EMAIL,
	GAUNTLET_ORG_USERNAME,
	GAUNTLET_POSTS,
	GAUNTLET_SLUG_PREFIX,
	GAUNTLET_VIEWER_EMAIL,
	GAUNTLET_VIEWER_USERNAME,
	type GauntletPost,
} from "@anthers/db/gauntlet";
import {
	WALK_BADGES,
	WALK_CREATOR_EMAIL,
	WALK_CREATOR_USERNAME,
	WALK_POSTS,
	WALK_SLUG_PREFIX,
	WALK_VIEWER_EMAIL,
	WALK_VIEWER_USERNAME,
} from "@anthers/db/gauntlet-walk";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { anthersLadderMissing, ensureAnthersBadges } from "../services/anthers-badges.js";
import { hostedHandleSuffix } from "../services/hosted-accounts.js";
import { createLocalAccount, localHandleName } from "./local-accounts.js";

const TAG = "[gauntlet]";

/**
 * Which copy of the fixture this run acts on. The values are the selected identifiers
 * themselves, so every helper below takes this one object and reads nothing from the
 * module constants directly — a helper that reads a constant skips the parameterization,
 * and the next instance to come along re-forks the script.
 */
interface Instance {
	/** The instance's own creator, whose account and Works the seeding owns. */
	creatorUsername: string;
	creatorEmail: string;
	/** The instance's own viewer — the account `--ensure-viewer` creates and resets. */
	viewerUsername: string;
	viewerEmail: string;
	/** The instance's slug prefix; `deleteGauntletPosts` scopes deletions with it. */
	slugPrefix: string;
	/** The instance's posts, carrying its slug prefix and its publicId range. */
	posts: GauntletPost[];
	/** The instance's advertised Badge ladder, rebuilt by `resetGates`. */
	badges: typeof GAUNTLET_BADGES;
	/** Which `--instance` value selected this, for the log lines. */
	name: "a" | "walk";
}

/** Instance A — the shared fixture exactly as `gauntlet.ts` defines it, the default. */
const INSTANCE_A: Instance = {
	creatorUsername: GAUNTLET_CREATOR_USERNAME,
	creatorEmail: GAUNTLET_CREATOR_EMAIL,
	viewerUsername: GAUNTLET_VIEWER_USERNAME,
	viewerEmail: GAUNTLET_VIEWER_EMAIL,
	slugPrefix: GAUNTLET_SLUG_PREFIX,
	posts: GAUNTLET_POSTS,
	badges: GAUNTLET_BADGES,
	name: "a",
};

/** Instance B — the walk's own fixture, `gauntlet-walk.ts`'s derivation. */
const INSTANCE_WALK: Instance = {
	creatorUsername: WALK_CREATOR_USERNAME,
	creatorEmail: WALK_CREATOR_EMAIL,
	viewerUsername: WALK_VIEWER_USERNAME,
	viewerEmail: WALK_VIEWER_EMAIL,
	slugPrefix: WALK_SLUG_PREFIX,
	posts: WALK_POSTS,
	badges: WALK_BADGES,
	name: "walk",
};

/**
 * Read the `--instance` flag. Only `walk` selects something other than the default, and
 * an unrecognized value refuses loudly — silently seeding instance A when `--instance`
 * was misspelled would reset a fixture the caller believes is B's.
 */
function resolveInstance(): Instance {
	const i = process.argv.indexOf("--instance");
	const value = i !== -1 ? process.argv[i + 1]?.trim() : undefined;
	if (value === undefined || value === "a") return INSTANCE_A;
	if (value === "walk") return INSTANCE_WALK;
	throw new Error(`Unknown --instance "${value}" (expected "a" or "walk")`);
}

/**
 * The handle account creation actually wrote for a fixture name — the preferred name when
 * the server would issue it, or the `-dev` fallback `localHandleName` picks. The username
 * column is gone; the handle is an account's lookup key.
 */
async function fixtureHandle(name: string): Promise<string> {
	return `${localHandleName(name)}.${await hostedHandleSuffix()}`;
}

/**
 * Local content root, the same directory the API's LocalStorageService reads. Only used when the
 * storage backend is local — which is every place this fixture runs.
 */
const CONTENT_ROOT = localContentRoot();

/**
 * Resolve the viewer whose relationship with the creator the gauntlet walks.
 * `inst` names the default viewer only — the walk instance's `--ensure-viewer` resolves
 * the walk viewer, instance A's resolves `gauntlet_viewer` — while `--user` still
 * overrides which viewer gets reset, in either instance.
 */
function resolveViewerUsername(inst: Instance): string {
	const flagIndex = process.argv.indexOf("--user");
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1]?.trim() : undefined;
	if (process.argv.includes("--ensure-viewer")) {
		// The harness's own account; --user may still override which viewer gets reset.
		return fromFlag || inst.viewerUsername;
	}
	const username = fromFlag || process.env.DEV_ACCOUNT_USERNAME?.trim();
	if (!username) {
		throw new Error(
			"No viewer to reset. Set DEV_ACCOUNT_USERNAME in .env (the account `make dev` bootstraps), pass --user <username>, or pass --ensure-viewer for the harness's own account.",
		);
	}
	return username;
}

/** Create the harness-owned viewer account if it doesn't exist yet. */
async function ensureViewer(inst: Instance): Promise<void> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, await fixtureHandle(inst.viewerUsername)))
		.limit(1);
	if (existing) return;

	const created = await createLocalAccount({
		email: inst.viewerEmail,
		handleName: inst.viewerUsername,
		// Pre-verified: checkout and support carry requireVerified, and there is no email loop to
		// click through in a headless run. Signing in is the emailed code, read from the
		// session's mail catcher by the spec's own setup.
		emailVerified: true,
		fields: {
			displayName: "Gauntlet Viewer",
			bio: "The harness's viewer for automated User Gauntlet walks.",
			isCreator: false,
			// Terms accepted: the walk drives the app itself, whose guarded routes a
			// terms-owing account never reaches; onboarding has its own suites.
			termsAcceptedAt: new Date(),
		},
	});
	console.log(`${TAG} created viewer "${inst.viewerUsername}" (id ${created.id})`);
}

/**
 * The session's Anthers-stand-in account — the `users` row that owns the seeded Anthers
 * Badge ladder.
 *
 * See `GAUNTLET_ORG_USERNAME` for why the owner can be neither the creator nor the
 * viewer, and for why the account takes the reserved "anthers" name. This account gates
 * nothing and holds nothing; its only job is to be the issuer of the Anthers rungs so
 * Anthers-ladder reads and creator-ladder reads never collide.
 *
 * ⚠️ **Two fixture instances share this one account, so creation can lose a race.** When
 * the walk's seeder and instance A's seeder run side by side (the projects now run in
 * parallel), both can pass the `existing` check together, and the brought identity's
 * direct PDS creation makes exactly one creation fail — the handle is already taken.
 * The loser re-reads: the winner's account is there by then, and that is success —
 * this function's contract is "the org row exists, return its id", not "I created it".
 * Any other failure still throws.
 */
async function ensureOrg(): Promise<number> {
	const resolveId = async (): Promise<number | null> => {
		// The bypassed name, not `fixtureHandle`: `localHandleName` downgrades the reserved
		// "anthers" to "anthers-dev", but this account is created with `bypassReserved`, so
		// the handle it actually holds is `anthers.<suffix>`.
		const suffix = await hostedHandleSuffix();
		const [existing] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.atprotoHandle, `anthers.${suffix}`))
			.limit(1);
		return existing?.id ?? null;
	};

	const existing = await resolveId();
	if (existing) return existing;

	try {
		const created = await createLocalAccount({
			email: GAUNTLET_ORG_EMAIL,
			// ⭐ Brought, like the production account it stands in for: the real
			// `@anthers.org` account brought its Bluesky identity, and the brought path
			// has no reserved-name check — so the stand-in takes the reserved "anthers"
			// name on the session's own suffix without a hole in the reservation list.
			identity: "brought",
			handleName: GAUNTLET_ORG_USERNAME,
			bypassReserved: true,
			emailVerified: true,
			fields: {
				displayName: "Anthers (fixture)",
				bio: "The session's stand-in for the Anthers creator account; owns the seeded Anthers Badge ladder.",
				isCreator: false,
				termsAcceptedAt: new Date(),
			},
		});
		console.log(`${TAG} created Anthers stand-in "${GAUNTLET_ORG_USERNAME}" (id ${created.id})`);
		return created.id;
	} catch (err) {
		// The brought path has no pending-signup reservation, so the race is the PDS
		// refusing a handle another seeder just created — a raw fetch failure, not
		// `HandleReservedError` (that error belongs to the hosted reservation the old
		// shape used). The winner may still be between creating the identity and writing
		// its `users` row, so one re-read can see neither loser nor winner — poll briefly
		// for the account to appear, and only a poll that finds nothing by the deadline
		// is a real failure.
		const deadline = Date.now() + 10_000;
		for (;;) {
			const winner = await resolveId();
			if (winner) return winner;
			if (Date.now() > deadline) {
				throw err instanceof Error
					? new Error(
							`the Anthers stand-in "${GAUNTLET_ORG_USERNAME}" lost a creation race to another seeder and never appeared (${err.message})`,
						)
					: err;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}

/** Create the fixture creator if absent; return its id either way. */
async function ensureCreator(inst: Instance): Promise<number> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, await fixtureHandle(inst.creatorUsername)))
		.limit(1);
	if (existing) return existing.id;

	const created = await createLocalAccount({
		email: inst.creatorEmail,
		handleName: inst.creatorUsername,
		emailVerified: true,
		fields: {
			displayName: "Gauntlet Creator",
			bio: "A fixture creator for the User Gauntlet. Every post below sits on a known rung of the ladder.",
			isCreator: true,
			// Terms accepted, as with the viewer — the fixture drives the app, not onboarding.
			termsAcceptedAt: new Date(),
		},
	});
	console.log(`${TAG} created creator "${inst.creatorUsername}" (id ${created.id})`);
	return created.id;
}

/**
 * Link the fixture creator to a test-mode Stripe Connect account, so the purchase rung is
 * walkable.
 *
 * **Silent no-op when `GAUNTLET_STRIPE_ACCOUNT` is unset** — the `ensure-dev-account`
 * convention — so a fresh clone and CI (which have no Stripe keys) still seed cleanly and
 * simply skip rung 6, while a local run with the var set can complete a real test-mode
 * checkout.
 *
 * This exists because the link is the one part of the onboarding that does *not* survive.
 * The `acct_…` lives at Stripe and persists forever, but `stripe_accounts.user_id` cascades
 * on delete, so any DB rebuild silently drops the row and the fixture had no way to restore
 * it — which is exactly how a creator onboarded on 2026-07-23 was still reported "not
 * connected" a week later. Set the var and the link is reproducible instead of manual.
 */
async function ensureCreatorConnect(creatorId: number): Promise<void> {
	const acctId = process.env.GAUNTLET_STRIPE_ACCOUNT?.trim();
	if (!acctId) return;

	const [existing] = await db
		.select({ id: stripeAccounts.id })
		.from(stripeAccounts)
		.where(eq(stripeAccounts.userId, creatorId))
		.limit(1);
	if (existing) {
		await db
			.update(stripeAccounts)
			.set({
				stripeAccountId: acctId,
				chargesEnabled: true,
				payoutsEnabled: true,
				onboardingComplete: true,
				updatedAt: new Date(),
			})
			.where(eq(stripeAccounts.id, existing.id));
	} else {
		await db.insert(stripeAccounts).values({
			userId: creatorId,
			stripeAccountId: acctId,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
	}
	console.log(`${TAG} linked creator to Stripe Connect account ${acctId}`);
}

/**
 * Delete the fixture's posts — the SELECTED INSTANCE's posts, identified by its own slug
 * prefix, which is exactly what keeps instances A and B disjoint: instance A matches
 * `gauntlet-%`, instance B matches `walk-gauntlet-%`, and neither pattern contains the
 * other. Their content items, post_contents, assets, comments and purchases all cascade
 * from the post row, so this clears the whole subtree — which is what makes re-running
 * safe rather than additive.
 */
async function deleteGauntletPosts(inst: Instance, creatorId: number): Promise<void> {
	const rows = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.creatorId, creatorId), like(posts.slug, `${inst.slugPrefix}%`)));
	if (rows.length === 0) return;

	const postIds = rows.map((r) => r.id);
	// Works do NOT cascade from a post — they are the creator's Catalog and outlive any
	// announcement — so this fixture's own Works are collected and removed explicitly.
	//
	// Matched on the CREATOR, not the slug prefix. The gauntlet creator exists only for
	// this fixture, so everything it owns is fixture data by definition — whereas a
	// prefix match silently leaves behind any Work an earlier version of the fixture
	// named differently, and a leftover shows up as a duplicate card in the feed with a
	// stale date. That happened.
	const workRows = await db
		.select({ id: works.id })
		.from(works)
		.where(eq(works.creatorId, creatorId));

	await db.delete(posts).where(inArray(posts.id, postIds));
	if (workRows.length > 0) {
		await db.delete(works).where(
			inArray(
				works.id,
				workRows.map((w) => w.id),
			),
		);
	}
	console.log(`${TAG} removed ${postIds.length} fixture posts and ${workRows.length} Works`);
}

/**
 * Write one gauntlet fixture entry: a **Work** carrying the gate, plus a post announcing
 * it. The Work is the subject — the staircase this fixture exists to walk is an access
 * staircase, and access lives on the Work. The post is there so the announcement side of
 * the model is exercised too, and it deliberately confers nothing.
 */
async function createPost(creatorId: number, spec: GauntletPost): Promise<number> {
	const [work] = await db
		.insert(works)
		.values({
			creatorId,
			publicId: spec.publicId,
			slug: spec.slug,
			type: spec.contentType,
			title: spec.title,
			// `description` is the PUBLIC blurb — a locked Work still has to say what it is,
			// the way a storefront page does. The gated payload is `body`/`bodyHtml`, which
			// is why the two must not be the same string here.
			description: `${spec.title} — a gauntlet fixture.`,
			body: spec.body,
			bodyHtml: `<p>${spec.body}</p>`,
			streamEnabled: spec.streamEnabled,
			downloadEnabled: spec.downloadEnabled,
			access: spec.access,
			visibility: "released",
			// Seeded Works stand for properly released ones, and release is gated on a
			// declared rating with every row of its matrix answered AND on a credit naming a
			// human (`credits_creator_required`) — released states neither gate would produce.
			credits: [{ role: "Made by", contributor: "The Fixture Creator", types: ["created"] }],
			// Every row Not in It, which is General.
			maturity: "general",
			maturityRows: rowsRatedAs("general"),
			maturitySource: "creator",
			releasedAt: new Date(),
		})
		.returning({ id: works.id });

	const [inserted] = await db
		.insert(posts)
		.values({
			creatorId,
			publicId: spec.publicId + 1_000,
			slug: `${spec.slug}-post`,
			title: spec.title,
			// The stored form is markdown; the announcement's body is its text as written.
			body: spec.body,
			isPublished: true,
			publishedAt: new Date(),
		})
		.returning({ id: posts.id });
	await db.insert(postWorkRefs).values({ postId: inserted.id, workId: work.id, position: 0 });

	if (spec.downloadEnabled) {
		// The checkout sums the Work's asset bytes for the delivery fee, and the download
		// route needs a real key to sign — so a downloadable Work needs an asset.
		const item = work;
		const fileKey = `creators/${creatorId}/assets/${spec.slug}.zip`;
		await db.insert(assets).values({
			workId: item.id,
			file: fileKey,
			filename: `${spec.slug}.zip`,
			// Fixed, not random: the delivery fee is derived from this, so a stable size
			// keeps the quoted price stable across runs. The fee math reads THIS number,
			// not the bytes on disk, so the real object below can stay tiny.
			fileSize: 64 * 1024 * 1024,
			mimeType: "application/zip",
			platform: "windows",
		});
		await writeDownloadObject(fileKey);
	}
	return inserted.id;
}

/**
 * Put a real object behind the downloadable asset so the post-purchase download actually
 * serves. Local storage only (which is everywhere this fixture runs); the content is a
 * minimal valid EMPTY zip — the 22-byte end-of-central-directory record — so whatever
 * fetches it can even open it.
 */
async function writeDownloadObject(fileKey: string): Promise<void> {
	if ((process.env.STORAGE_BACKEND ?? "local") !== "local") return;
	const target = join(CONTENT_ROOT, fileKey);
	await mkdir(dirname(target), { recursive: true });
	const eocd = new Uint8Array(22);
	eocd.set([0x50, 0x4b, 0x05, 0x06]); // "PK\x05\x06", all remaining fields zero
	await Bun.write(target, eocd);
}

/** Rebuild the creator's advertised Badge ladder from scratch. */
async function resetGates(inst: Instance, creatorId: number): Promise<void> {
	await db.delete(badges).where(eq(badges.creatorId, creatorId));
	await db.insert(badges).values(inst.badges.map((b) => ({ ...b, creatorId })));
}

/**
 * Put the viewer back on the floor. Everything here is scoped to this fixture — the
 * viewer's own account, content and other relationships are left alone.
 */
async function resetViewer(viewerId: number, creatorId: number, postIds: number[]): Promise<void> {
	// The floor is no holding at all: Free is the absence of org-ladder and creator-ladder
	// rows this cycle, and the viewer's Anthers-side reads answer 0 for a user with no
	// holdings — which is what "Badge back to Free" means under the Badge model. The org's
	// rungs go too, since a prior hop may have parked one on the staircase. There is no
	// billing row to touch: the amounts the old reset zeroed are `user_badges` holdings
	// now, and the billing table carries no amount to reset.
	await db.delete(userBadges).where(eq(userBadges.userId, viewerId));

	await db
		.delete(follows)
		.where(and(eq(follows.followerId, viewerId), eq(follows.creatorId, creatorId)));

	// Badge holdings ratchet within a cycle (add-only), so a re-run inside the same month
	// CANNOT walk back down through the UI. Clearing the viewer's holdings on this creator
	// is what makes the gate rung repeatable at all. Scoped through the ladder's badges
	// rather than by a creator id on the holding: `user_badges` carries the badge, and the
	// issuer is reachable through it — which is the shape every reader of "who holds this
	// creator's Badges" now takes.
	await db
		.delete(userBadges)
		.where(
			sql`${userBadges.userId} = ${viewerId} AND ${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${creatorId})`,
		);

	await db
		.delete(poolDistributions)
		.where(
			and(eq(poolDistributions.subscriberId, viewerId), eq(poolDistributions.creatorId, creatorId)),
		);

	await db
		.delete(attentionEvents)
		.where(and(eq(attentionEvents.userId, viewerId), eq(attentionEvents.creatorId, creatorId)));

	// A purchase unlocks permanently, so a leftover one would silently pre-open G9.
	//
	// Cleared by the synthetic PaymentIntent id, NOT by Work id. The fixture deletes and
	// recreates its Works on every reset, so they come back with fresh ids — an id-based
	// clear can only ever reach the CURRENT generation, while the hop's idempotency check
	// keys on the (stable) PaymentIntent id and would then skip writing a new row. The
	// result was a purchase pointing at a Work that no longer exists, G9 reading
	// `payment_required` forever, and a reset that looked like it had worked.
	await db
		.delete(purchases)
		.where(
			and(
				eq(purchases.buyerId, viewerId),
				like(purchases.stripePaymentIntentId, "pi_gauntlet_hop_%"),
			),
		);

	if (postIds.length > 0) {
		// Clear the viewer's own comments so the comment rung starts empty each run.
		// Comments are polymorphic now, so the subject type has to be named — without it
		// this would also match a Work whose id happened to collide with a post's.
		await db
			.delete(comments)
			.where(
				and(
					eq(comments.userId, viewerId),
					eq(comments.subjectType, "post"),
					inArray(comments.subjectId, postIds),
				),
			);
	}
}

/** Remove the fixture entirely — creator, posts, gates and all — for the given instance. */
async function clean(inst: Instance): Promise<void> {
	const [creator] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, await fixtureHandle(inst.creatorUsername)))
		.limit(1);
	if (!creator) {
		console.log(`${TAG} nothing to clean — no "${inst.creatorUsername}".`);
		return;
	}
	await deleteGauntletPosts(inst, creator.id);
	// Everything else the creator owns (gates, follows, allocations) cascades from the user.
	await db.delete(users).where(eq(users.id, creator.id));
	// The download object under the fixture creator's storage prefix goes with it.
	if ((process.env.STORAGE_BACKEND ?? "local") === "local") {
		await rm(join(CONTENT_ROOT, `creators/${creator.id}`), { recursive: true, force: true });
	}
	console.log(`${TAG} removed the instance-${inst.name} fixture creator and all its rows.`);
}

async function main(): Promise<void> {
	assertDevCheckout();

	const inst = resolveInstance();

	if (process.argv.includes("--clean")) {
		await clean(inst);
		return;
	}

	if (process.argv.includes("--ensure-viewer")) {
		await ensureViewer(inst);
	}
	const viewerUsername = resolveViewerUsername(inst);
	const viewerHandle = await fixtureHandle(viewerUsername);
	const [viewer] = await db
		.select({ id: users.id, handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.atprotoHandle, viewerHandle))
		.limit(1);
	if (!viewer) {
		throw new Error(
			`Viewer "${viewerUsername}" not found. Run \`make dev\` once (it bootstraps DEV_ACCOUNT_USERNAME), or pass --user with an account that exists.`,
		);
	}

	const creatorId = await ensureCreator(inst);
	await ensureCreatorConnect(creatorId);
	await deleteGauntletPosts(inst, creatorId);

	const postIds: number[] = [];
	for (const spec of inst.posts) {
		postIds.push(await createPost(creatorId, spec));
	}
	await resetGates(inst, creatorId);
	await resetViewer(viewer.id, creatorId, postIds);

	// The Anthers ladder is platform state, not dev-account state: every reader of "what the
	// viewer holds on Anthers' ladder" (`heldAnthersBadgeAmount` and its call sites) throws
	// loudly when no ladder exists, and an e2e session runs this script rather than
	// `db:seed` — so the ladder is ensured here, owned by the fixture's Anthers stand-in
	// (see `GAUNTLET_ORG_USERNAME` for why the owner can be neither the creator nor the
	// viewer). `ensure-dev-account` (the dev door) seeds the same rows owned by the dev
	// account; whichever runs first wins and both are idempotent.
	// 🚨 **This must run AFTER `resetGates`** — that rebuild deletes every badge the
	// fixture creator owns, and the Anthers rows would be rebuilt by nobody if seeded first.
	if (await anthersLadderMissing()) {
		const orgId = await ensureOrg();
		await ensureAnthersBadges(orgId);
		console.log(`${TAG} seeded the Anthers Badge ladder (owned by ${GAUNTLET_ORG_USERNAME})`);
	}

	console.log("");
	console.log(`${TAG} Ready. Instance ${inst.name} — the gauntlet starts here:`);
	console.log("");
	console.log(`  Creator  /${inst.creatorUsername}  (${inst.posts.length} posts)`);
	console.log(
		`  Viewer   ${viewer.handle}  —  Free badge · giving $0 · not following · nothing purchased`,
	);
	console.log("");
	for (const spec of inst.posts) {
		console.log(`  ${spec.key}  /posts/${spec.slug.padEnd(24)} unlocks: ${spec.unlocksWhen}`);
	}
	console.log("");
	console.log(`${TAG} Walk it from /${inst.creatorUsername}. Re-run this to start over.`);
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
	process.exit(1);
}
