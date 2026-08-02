// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The User Gauntlet fixture — deterministic, idempotent, and self-cleaning.
 *
 * Builds `gauntlet_creator` and the nine posts defined in `gauntlet.ts`, then resets the
 * viewer to the gauntlet's floor: Free badge, no Seeds, not following, nothing purchased,
 * no comments. Run it before every gauntlet walk; it always produces the same starting
 * state, which is the whole point — a gauntlet that starts somewhere slightly different
 * each time can't tell you what changed.
 *
 * Deliberately NOT an extension of `seed.ts`: that one is a random demo seeder (randomInt,
 * pick, fuzzy dates) whose whole job is to make the app look populated. A fixture's job is
 * the opposite — to be boring and identical every time.
 *
 * Usage:
 *   bun run db:gauntlet                 # reset to the floor (make gauntlet-reset)
 *   bun run db:gauntlet --user alice    # use a viewer other than DEV_ACCOUNT_USERNAME
 *   bun run db:gauntlet --ensure-viewer # create + use the harness's own gauntlet_viewer
 *   bun run db:gauntlet --clean         # remove the fixture entirely, then stop
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
 * Spec: `40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import {
	GAUNTLET_CREATOR_EMAIL,
	GAUNTLET_CREATOR_PASSWORD,
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_GATES,
	GAUNTLET_POSTS,
	GAUNTLET_SLUG_PREFIX,
	GAUNTLET_VIEWER_EMAIL,
	GAUNTLET_VIEWER_PASSWORD,
	GAUNTLET_VIEWER_USERNAME,
	type GauntletPost,
} from "./gauntlet.js";
import {
	accounts,
	assets,
	attentionEvents,
	comments,
	works,
	creatorGates,
	db,
	follows,
	poolDistributions,
	postWorkRefs,
	posts,
	purchases,
	seedAllocations,
	stripeAccounts,
	users,
} from "./index.js";

const TAG = "[gauntlet]";

/**
 * Local content root, mirroring the API's LocalStorageService (repo root /content/).
 * Only used when the storage backend is local — which is every place this fixture runs.
 */
const CONTENT_ROOT = join(import.meta.dir, "../../../content");

/** Resolve the viewer whose relationship with the creator the gauntlet walks. */
function resolveViewerUsername(): string {
	const flagIndex = process.argv.indexOf("--user");
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1]?.trim() : undefined;
	if (process.argv.includes("--ensure-viewer")) {
		// The harness's own account; --user may still override which viewer gets reset.
		return fromFlag || GAUNTLET_VIEWER_USERNAME;
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
async function ensureViewer(): Promise<void> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, GAUNTLET_VIEWER_USERNAME))
		.limit(1);
	if (existing) return;

	const passwordHash = await Bun.password.hash(GAUNTLET_VIEWER_PASSWORD, {
		algorithm: "argon2id",
	});
	const [created] = await db
		.insert(users)
		.values({
			username: GAUNTLET_VIEWER_USERNAME,
			email: GAUNTLET_VIEWER_EMAIL,
			passwordHash,
			displayName: "Gauntlet Viewer",
			bio: "The harness's viewer for automated User Gauntlet walks.",
			isCreator: false,
			// Pre-verified: checkout and Seed-giving carry requireVerified, and there is no
			// email loop to click through in a headless run.
			emailVerified: true,
		})
		.returning({ id: users.id });
	console.log(`${TAG} created viewer "${GAUNTLET_VIEWER_USERNAME}" (id ${created.id})`);
}

/** Create the fixture creator if absent; return its id either way. */
async function ensureCreator(): Promise<number> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, GAUNTLET_CREATOR_USERNAME))
		.limit(1);
	if (existing) return existing.id;

	const passwordHash = await Bun.password.hash(GAUNTLET_CREATOR_PASSWORD, {
		algorithm: "argon2id",
	});
	const [created] = await db
		.insert(users)
		.values({
			username: GAUNTLET_CREATOR_USERNAME,
			email: GAUNTLET_CREATOR_EMAIL,
			passwordHash,
			displayName: "Gauntlet Creator",
			bio: "A fixture creator for the User Gauntlet. Every post below sits on a known rung of the ladder.",
			isCreator: true,
			emailVerified: true,
		})
		.returning({ id: users.id });
	console.log(`${TAG} created creator "${GAUNTLET_CREATOR_USERNAME}" (id ${created.id})`);
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
 * Delete the fixture's posts. Their content items, post_contents, assets, comments and
 * purchases all cascade from the post row, so this clears the whole subtree — which is what
 * makes re-running safe rather than additive.
 */
async function deleteGauntletPosts(creatorId: number): Promise<void> {
	const rows = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.creatorId, creatorId), like(posts.slug, `${GAUNTLET_SLUG_PREFIX}%`)));
	if (rows.length === 0) return;

	const postIds = rows.map((r) => r.id);
	// Works do NOT cascade from a post — they are the creator's Catalog and outlive any
	// announcement — so this fixture's own Works are collected and removed explicitly.
	const workRows = await db
		.select({ id: works.id })
		.from(works)
		.where(and(eq(works.creatorId, creatorId), like(works.slug, `${GAUNTLET_SLUG_PREFIX}%`)));

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
			description: spec.body,
			body: spec.body,
			bodyHtml: `<p>${spec.body}</p>`,
			streamEnabled: spec.streamEnabled,
			downloadEnabled: spec.downloadEnabled,
			anthersAccess: spec.anthersAccess,
			seedAccess: spec.seedAccess,
			visibility: "released",
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
			body: spec.body,
			bodyHtml: `<p>${spec.body}</p>`,
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

/** Rebuild the creator's advertised gate ladder from scratch. */
async function resetGates(creatorId: number): Promise<void> {
	await db.delete(creatorGates).where(eq(creatorGates.creatorId, creatorId));
	await db.insert(creatorGates).values(GAUNTLET_GATES.map((g) => ({ ...g, creatorId })));
}

/**
 * Put the viewer back on the floor. Everything here is scoped to this fixture — the
 * viewer's own account, content and other relationships are left alone.
 */
async function resetViewer(viewerId: number, creatorId: number, postIds: number[]): Promise<void> {
	// Badge back to Free and Seeds back to zero. Upsert: the account row may not exist yet
	// if this login has never visited /subscribe.
	const [account] = await db
		.select({ id: accounts.id })
		.from(accounts)
		.where(eq(accounts.userId, viewerId))
		.limit(1);
	if (account) {
		await db
			.update(accounts)
			.set({ anthersSeeds: 0, creatorSeedTotal: "0.00", updatedAt: new Date() })
			.where(eq(accounts.userId, viewerId));
	} else {
		await db
			.insert(accounts)
			.values({ userId: viewerId, anthersSeeds: 0, creatorSeedTotal: "0.00" });
	}

	await db
		.delete(follows)
		.where(and(eq(follows.followerId, viewerId), eq(follows.creatorId, creatorId)));

	// Seed allocations ratchet within a cycle (add-only), so a re-run inside the same month
	// CANNOT walk back down through the UI. Clearing them here is what makes the Seed rung
	// repeatable at all.
	await db
		.delete(seedAllocations)
		.where(and(eq(seedAllocations.userId, viewerId), eq(seedAllocations.creatorId, creatorId)));

	await db
		.delete(poolDistributions)
		.where(
			and(eq(poolDistributions.subscriberId, viewerId), eq(poolDistributions.creatorId, creatorId)),
		);

	await db
		.delete(attentionEvents)
		.where(and(eq(attentionEvents.userId, viewerId), eq(attentionEvents.creatorId, creatorId)));

	// A purchase unlocks permanently, so a leftover one would silently pre-open G9. It
	// now names a Work, so clear against the fixture's Works rather than its posts.
	const fixtureWorks = await db
		.select({ id: works.id })
		.from(works)
		.where(and(eq(works.creatorId, creatorId), like(works.slug, `${GAUNTLET_SLUG_PREFIX}%`)));
	if (fixtureWorks.length > 0) {
		await db.delete(purchases).where(
			and(
				eq(purchases.buyerId, viewerId),
				inArray(
					purchases.workId,
					fixtureWorks.map((w) => w.id),
				),
			),
		);
	}

	if (postIds.length > 0) {
		// Clear the viewer's own comments so the comment rung starts empty each run.
		await db
			.delete(comments)
			.where(and(eq(comments.userId, viewerId), inArray(comments.postId, postIds)));
	}
}

/** Remove the fixture entirely — creator, posts, gates and all. */
async function clean(): Promise<void> {
	const [creator] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, GAUNTLET_CREATOR_USERNAME))
		.limit(1);
	if (!creator) {
		console.log(`${TAG} nothing to clean — no "${GAUNTLET_CREATOR_USERNAME}".`);
		return;
	}
	await deleteGauntletPosts(creator.id);
	// Everything else the creator owns (gates, follows, allocations) cascades from the user.
	await db.delete(users).where(eq(users.id, creator.id));
	// The download object under the fixture creator's storage prefix goes with it.
	if ((process.env.STORAGE_BACKEND ?? "local") === "local") {
		await rm(join(CONTENT_ROOT, `creators/${creator.id}`), { recursive: true, force: true });
	}
	console.log(`${TAG} removed the fixture creator and all its rows.`);
}

async function main(): Promise<void> {
	if (process.argv.includes("--clean")) {
		await clean();
		return;
	}

	if (process.argv.includes("--ensure-viewer")) {
		await ensureViewer();
	}

	const viewerUsername = resolveViewerUsername();
	const [viewer] = await db
		.select({ id: users.id, username: users.username })
		.from(users)
		.where(eq(users.username, viewerUsername))
		.limit(1);
	if (!viewer) {
		throw new Error(
			`Viewer "${viewerUsername}" not found. Run \`make dev\` once (it bootstraps DEV_ACCOUNT_USERNAME), or pass --user with an account that exists.`,
		);
	}

	const creatorId = await ensureCreator();
	await ensureCreatorConnect(creatorId);
	await deleteGauntletPosts(creatorId);

	const postIds: number[] = [];
	for (const spec of GAUNTLET_POSTS) {
		postIds.push(await createPost(creatorId, spec));
	}
	await resetGates(creatorId);
	await resetViewer(viewer.id, creatorId, postIds);

	console.log("");
	console.log(`${TAG} Ready. The gauntlet starts here:`);
	console.log("");
	console.log(`  Creator  /${GAUNTLET_CREATOR_USERNAME}  (${GAUNTLET_POSTS.length} posts)`);
	console.log(
		`  Viewer   ${viewer.username}  —  Free badge · 0 Seeds · not following · nothing purchased`,
	);
	console.log("");
	for (const spec of GAUNTLET_POSTS) {
		console.log(`  ${spec.key}  /posts/${spec.slug.padEnd(24)} unlocks: ${spec.unlocksWhen}`);
	}
	console.log("");
	console.log(`${TAG} Walk it from /${GAUNTLET_CREATOR_USERNAME}. Re-run this to start over.`);
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
	process.exit(1);
}
