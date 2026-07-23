// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The User Gauntlet spec pass — one viewer's whole arc with one creator, walked in order,
 * asserting every cell of the expected-access staircase after every transition.
 *
 * The staircase (`EXPECTED_STAIRCASE`) and the nine posts (`GAUNTLET_POSTS`) come from
 * `@anthers/db/gauntlet` — the same definitions `make gauntlet-reset` seeds and the
 * access-staircase unit test proves against the pure resolver. This spec adds what neither
 * can: the real app, a real session, and the transitions between states.
 *
 * HYBRID MODE (the default). The support model made billing real: changing the
 * Anthers-Seed count and buying creator-Seed budget are Stripe charges with
 * webhook-driven sync — 503 without Stripe configured, and needing a running
 * `stripe listen` forwarder with it. So this spec UI-walks every transition that
 * doesn't bill (follow, comment, the Give-Seeds stepper) and hops the billing facts
 * through `db:gauntlet:state` — the canonical script, the same columns the webhooks
 * would write. The observational pass (and an eventual GAUNTLET_STRIPE mode) covers
 * the real billing UI; the staircase itself is asserted identically either way.
 *
 * Serial on purpose: it is one stateful walk, not independent tests. A retry restarts
 * the whole file, and beforeAll's fixture reset makes that (and re-runs) safe.
 *
 * Spec: `40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	EXPECTED_STAIRCASE,
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_POSTS,
	GAUNTLET_VIEWER_USERNAME,
	gauntletPost,
	type StaircaseState,
} from "@anthers/db/gauntlet";
import { expect, type Page, test } from "@playwright/test";
import { API_URL, trackErrorsStrict } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

test.describe.configure({ mode: "serial" });

/** Hop the viewer's billing state through the canonical fixture script. */
function hop(...args: string[]): void {
	execFileSync("bun", ["run", "db:gauntlet:state", "--user", GAUNTLET_VIEWER_USERNAME, ...args], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
}

/**
 * The one documented allowance for the strict tracker: an in-flight fetch aborted by the
 * next `page.goto` rejects as "TypeError: Failed to fetch" and surfaces as a console
 * error on slower machines (CI reliably; rarely locally). It is a navigation artifact,
 * not an app failure — a genuinely unreachable API fails the walk's own functional
 * assertions (unlock panels, staircase rows) long before this tracker would.
 */
const NAVIGATION_ABORTED_FETCH = /TypeError: Failed to fetch/;
const ALLOWED = [NAVIGATION_ABORTED_FETCH];

/** slug → numeric post id, resolved once from the live API (the access route keys on id). */
const postIds: Record<string, number> = {};

function staircaseRow(state: string): StaircaseState {
	const row = EXPECTED_STAIRCASE.find((r) => r.state === state);
	if (!row) throw new Error(`No staircase state "${state}"`);
	return row;
}

/**
 * Assert one whole row of the staircase: the observed reason for all nine posts, in one
 * comparison so a failure shows the full observed-vs-expected row. Also pins G9's quoted
 * price whenever the row expects `payment_required`.
 */
async function expectStaircase(page: Page, stateName: string): Promise<void> {
	const row = staircaseRow(stateName);
	const observed: Record<string, string> = {};
	for (const post of GAUNTLET_POSTS) {
		const res = await page.request.get(`${API_URL}/api/subscriptions/access/${postIds[post.key]}`);
		expect(res.ok(), `access lookup failed for ${post.key}: ${res.status()}`).toBe(true);
		const body = (await res.json()) as { reason: string; price: string | null };
		observed[post.key] = body.reason;
		if (row.reasons[post.key] === "payment_required") {
			expect(body.price, `${stateName} → ${post.key} quoted price`).toBe("9.99");
		}
	}
	expect(observed, `staircase row "${stateName}"`).toEqual(row.reasons);
}

/** The post page's own verdict: unlocked shows the body, locked shows the unlock panel. */
async function expectPostUnlocked(page: Page, key: string): Promise<void> {
	const spec = gauntletPost(key);
	await page.goto(`/posts/${spec.slug}`);
	await expect(page.getByText(spec.body)).toBeVisible();
	await expect(page.getByRole("heading", { name: "Unlock this post" })).toBeHidden();
}

async function expectPostLocked(page: Page, key: string): Promise<void> {
	const spec = gauntletPost(key);
	await page.goto(`/posts/${spec.slug}`);
	await expect(page.getByRole("heading", { name: "Unlock this post" })).toBeVisible();
	// The API strips a locked post's body server-side; trust nothing client-side.
	await expect(page.getByText(spec.body)).toBeHidden();
}

test.beforeAll(async () => {
	// Reset to the floor through the canonical script — this is what makes re-runs and
	// retries deterministic. The viewer's session survives (reset never touches sessions).
	execFileSync("bun", ["run", "db:gauntlet", "--ensure-viewer"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	for (const post of GAUNTLET_POSTS) {
		const res = await fetch(`${API_URL}/api/content/posts/${post.slug}`);
		if (!res.ok) throw new Error(`Fixture post ${post.slug} not reachable: ${res.status}`);
		const body = (await res.json()) as { post: { id: number } };
		postIds[post.key] = body.post.id;
	}
});

test("rung 1 — the floor: free streams, everything else reads locked", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	// Following nobody, the feed short-circuits to [] — the gauntlet posts must not leak in.
	await page.goto("/feed");
	await expect(page.getByText(gauntletPost("G1").title)).toBeHidden();

	await expectPostUnlocked(page, "G1");
	await expectPostLocked(page, "G2");
	await expectPostLocked(page, "G6");

	await expectStaircase(page, "Free, unfollowed");
	expect(errors).toEqual([]);
});

test("rung 2 — follow: the feed fills, access does not change", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	await page.goto(`/${GAUNTLET_CREATOR_USERNAME}`);
	await page.getByRole("button", { name: "Follow", exact: true }).click();
	await expect(page.getByRole("button", { name: "Following" })).toBeVisible();

	await page.goto("/feed");
	await expect(page.getByText(gauntletPost("G1").title)).toBeVisible();

	// The negative assertion this rung exists for: following is not entitlement.
	// The row must be IDENTICAL to the unfollowed floor.
	await expectStaircase(page, "Free, following");
	expect(errors).toEqual([]);
});

test("rung 3 — comment on the free post", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	await page.goto(`/posts/${gauntletPost("G1").slug}`);
	const commentText = "Walking the gauntlet — first rung comment.";
	await page.getByPlaceholder("Write a comment...").fill(commentText);
	await page.getByRole("button", { name: "Post comment" }).click();
	await expect(page.getByText(commentText)).toBeVisible();
	// Exact match: the nav renders a (hidden) "@gauntlet_viewer" that substring-matching
	// would find first; the comment author span is the bare username.
	await expect(page.getByText(GAUNTLET_VIEWER_USERNAME, { exact: true })).toBeVisible();

	// The negative the spec says to RECORD, not assume: can a user comment on a post they
	// cannot access? The comment route carries requireAuth and no access check, so the
	// honest expectation today is yes. If this ever starts failing, the product got
	// stricter — update the spec doc's rung-3 note along with this assertion.
	const res = await page.request.post(
		`${API_URL}/api/content/posts/${gauntletPost("G2").slug}/comments`,
		{
			data: { body: "Commenting on a post I cannot read (recorded gauntlet behavior)." },
			headers: { Origin: "http://localhost:4173" },
		},
	);
	expect(res.status(), "commenting on an inaccessible post (recorded behavior)").toBe(201);

	expect(errors).toEqual([]);
});

// ── The Anthers-Seed ladder, one rung at a time ──────────────────────────────
// Each hop sets the count the subscription webhook would have written; the staircase
// must gain EXACTLY one post per rung, and the rung above must stay shut.
for (const [seeds, state, unlocked, stillLocked] of [
	[1, "Root", "G2", "G3"],
	[2, "Sprout", "G3", "G4"],
	[3, "Petal", "G4", "G5"],
	[4, "Blossom", "G5", "G6"],
] as const) {
	test(`rung 4 — ${state}: exactly one more post unlocks`, async ({ page }) => {
		const errors = trackErrorsStrict(page, ALLOWED);
		hop("--anthers-seeds", String(seeds));

		await expectPostUnlocked(page, unlocked);
		await expectPostLocked(page, stillLocked);
		await expectStaircase(page, state);
		expect(errors).toEqual([]);
	});
}

// ── The Seed ladder, through the real Give-Seeds control ─────────────────────
test("rung 5 — Seed budget alone unlocks nothing", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);
	// Two bought Seeds' worth of budget ($3 each). Holding budget is not giving it —
	// the staircase must still read exactly as Blossom.
	hop("--seed-budget", "6");
	await expectStaircase(page, "Blossom");
	expect(errors).toEqual([]);
});

for (const [target, delta, state, unlocked, stillLocked] of [
	[1, 1, "Blossom + $1 given", "G6", "G7"],
	[2, 1, "Blossom + $2 given", "G7", "G8"],
	[4, 2, "Blossom + $4 given", "G8", null],
] as const) {
	test(`rung 5 — give to $${target}: exactly one more post unlocks`, async ({ page }) => {
		const errors = trackErrorsStrict(page, ALLOWED);

		await page.goto(`/${GAUNTLET_CREATOR_USERNAME}?tab=tiers`);
		const plus = page.getByRole("button", { name: "More seeds" });
		for (let i = 0; i < delta; i++) await plus.click();
		await page.getByRole("button", { name: `Give $${delta.toFixed(2)}` }).click();
		// The give settles when the button returns to its resting label.
		await expect(page.getByRole("button", { name: "Give Seeds" })).toBeVisible();

		await expectPostUnlocked(page, unlocked);
		if (stillLocked) await expectPostLocked(page, stillLocked);
		await expectStaircase(page, state);
		expect(errors).toEqual([]);
	});
}

test("rung 5 — the ratchet: the stepper cannot walk back down", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);
	await page.goto(`/${GAUNTLET_CREATOR_USERNAME}?tab=tiers`);
	// $4 is committed; within the cycle the control's floor IS the committed amount.
	await expect(page.getByRole("button", { name: "Fewer seeds" })).toBeDisabled();
	expect(errors).toEqual([]);
});

// ── The purchase rung ────────────────────────────────────────────────────────
test("rung 6 — purchase unlocks the download, and only the purchase does", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	// Even from the very top of both ladders, G9 still quotes its price — asserted by
	// every row so far. Now the hop writes the completed purchase the payment webhook
	// would have written (the real charge belongs to the Stripe walk).
	hop("--purchase", gauntletPost("G9").slug);

	await expectStaircase(page, "+ purchased");

	// The post page must now offer the download instead of a checkout.
	await page.goto(`/posts/${gauntletPost("G9").slug}`);
	await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
	await expect(page.getByText("Purchase this post to access downloads.")).toBeHidden();

	expect(errors).toEqual([]);
});

test("the ladders only ever climbed — no state unlocked less than the one before", () => {
	// The per-state rows all passed to reach this point; this pins the shape of the whole
	// table one more time at the source of truth, so a future edit that breaks the
	// monotonic climb fails here even if each row is internally consistent.
	let previous = 0;
	for (const row of EXPECTED_STAIRCASE) {
		const unlocked = Object.values(row.reasons).filter(
			(r) => r !== "gated" && r !== "payment_required",
		).length;
		expect(
			unlocked,
			`${row.state} unlocks fewer posts than the state before it`,
		).toBeGreaterThanOrEqual(previous);
		previous = unlocked;
	}
});
