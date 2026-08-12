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
	SEED_RUNGS,
	SEED_WALK,
	type StaircaseState,
} from "@anthers/db/gauntlet";
import { SEED_PRICE } from "@anthers/shared/constants";

/** The purchase rung's key — derived, so extending SEED_RUNGS doesn't strand it. */
const BUY = `G${2 + SEED_RUNGS.length}`;

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
const workIds: Record<string, number> = {};

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
		const res = await page.request.get(`${API_URL}/api/subscriptions/access/${workIds[post.key]}`);
		expect(res.ok(), `access lookup failed for ${post.key}: ${res.status()}`).toBe(true);
		const body = (await res.json()) as { reason: string; price: string | null };
		observed[post.key] = body.reason;
		if (row.reasons[post.key] === "payment_required") {
			expect(body.price, `${stateName} → ${post.key} quoted price`).toBe("9.99");
		}
	}
	expect(observed, `staircase row "${stateName}"`).toEqual(row.reasons);
}

/** The Work page's own verdict: unlocked shows the body, locked shows the unlock panel. */
async function expectPostUnlocked(page: Page, key: string): Promise<void> {
	const spec = gauntletPost(key);
	await page.goto(`/works/${spec.slug}`);
	await expect(page.getByText(spec.body)).toBeVisible();
	await expect(page.getByRole("heading", { name: "Unlock this post" })).toBeHidden();
}

/**
 * A locked post shows the unlock panel, and that panel says what it is locked BY and what
 * to do about it. The heading carries the gate's identity — "Locked · Root" when the gate
 * sits on a Badge, "Unlock this post" when it doesn't — and the CTA carries the *marginal*
 * ask, which is the thing a viewer actually needs: how many more Seeds, and to whom.
 */
async function expectPostLocked(page: Page, key: string): Promise<void> {
	const spec = gauntletPost(key);
	await page.goto(`/works/${spec.slug}`);
	await expect(page.getByRole("heading", { name: /^(Locked ·|Unlock this post)/ })).toBeVisible();
	// The ask must be marginal and must name a destination — never a bare "Join to unlock".
	await expect(
		page
			.getByRole("button", { name: /Unlock with \d+ more Seeds? to / })
			.or(page.getByRole("link", { name: /Unlock with \d+ more Seeds? to / })),
	).toBeVisible();
	// The API strips a locked post's body server-side; trust nothing client-side.
	await expect(page.getByText(spec.body)).toBeHidden();
}

// ── Real media: bytes, not reasons ───────────────────────────────────────────
/**
 * The assertions below are the reason `db:gauntlet:media` exists. Everything else in this
 * walk reads an access *reason*, and a reason-only suite cannot catch the bug class that
 * matters most here: the resolver correctly answering "gated" while a working URL to the
 * bytes sits in the same response. So for the two media posts we walk the delivery chain
 * to its end and look at what actually comes back.
 *
 * **These call the access-checked delivery endpoints by URL rather than following the
 * pointer in the post JSON, and that is deliberate.** With `STORAGE_BACKEND=local` the API
 * sets no delivery context (`deliveryCtxFor` returns null), so an entitled viewer is handed
 * the raw `/content/...` URL and the app never touches `/posts/:slug/hls/...` at all. A
 * test that followed the JSON pointer would therefore assert *static file serving* in dev
 * and the real route only in production — the weaker half, in the place with less scrutiny.
 * Addressing the endpoints directly exercises the same code in both modes.
 *
 * Scope, stated plainly: this proves the access check, the playlist rewrite, the redirect
 * and the bytes. It does **not** prove the stored object is private — locally `/content`
 * serves everything unsigned, so an ACL mistake is invisible here by construction. That
 * half is `storage-acl.test.ts`'s job, and the two together are the whole picture.
 */

/**
 * Whether the fixture carries real media. Keyed off ffmpeg the same way the seeder is,
 * NOT off what the API returned: inferring it from the response once made a broken
 * assertion look like a passing skip, which is the exact failure this suite exists to
 * prevent. If ffmpeg is here, these assertions run and must pass.
 */
let mediaSeeded = false;

interface ContentItemView {
	id: number;
	transcoding?: {
		status: string;
		hlsManifestUrl: string | null;
		outputFileUrl: string | null;
	} | null;
}

/** The Work as this viewer sees it — media URLs blanked when denied. */
async function mediaItem(page: Page, key: string): Promise<ContentItemView | null> {
	const spec = gauntletPost(key);
	const res = await page.request.get(`${API_URL}/api/content/works/${spec.slug}`);
	expect(res.ok(), `work fetch failed for ${key}: ${res.status()}`).toBe(true);
	const body = (await res.json()) as { work?: ContentItemView };
	return body.work ?? null;
}

/** The access-checked delivery routes for one Work. No post is involved. */
function hlsUrl(key: string, itemId: number, file = "master.m3u8"): string {
	return `${API_URL}/api/content/works/${itemId}/hls/${file}`;
}
function audioUrl(_key: string, itemId: number): string {
	return `${API_URL}/api/content/works/${itemId}/audio`;
}

/** Re-host a URL the API generated onto the API's own origin (see the note in the walk). */
function atApi(url: string): string {
	const u = new URL(url);
	return `${API_URL}${u.pathname}${u.search}`;
}

/** Walk master → variant → segment and confirm real transport-stream bytes come back. */
async function expectVideoBytes(page: Page, key: string): Promise<void> {
	const item = await mediaItem(page, key);
	expect(item?.transcoding?.status, `${key} transcode status`).toBe("completed");
	expect(
		item?.transcoding?.hlsManifestUrl,
		`${key} withheld its video from an entitled viewer`,
	).toBeTruthy();

	// 1. The master playlist, through the access-checked route.
	const master = await page.request.get(hlsUrl(key, item?.id as number));
	expect(master.status(), `${key} master playlist`).toBe(200);
	const masterBody = await master.text();
	expect(masterBody).toContain("#EXTM3U");

	// 2. A variant playlist. The master's rewrite points these back through the endpoint,
	//    so this URL is absolute and access-checked in its own right.
	const variantUrl = masterBody
		.split("\n")
		.find((l) => l.trim() && !l.startsWith("#"))
		?.trim();
	expect(variantUrl, `${key} master lists no variant playlist`).toBeTruthy();
	expect(variantUrl, `${key} variant ref was not rewritten to the delivery route`).toContain(
		"/hls/",
	);
	// The rewrite stamps `FRONTEND_URL` as the origin, because in production the site and
	// the API share one origin behind App Platform's ingress. This harness has no proxy —
	// the SPA is on :4173 and the API on :8000 — so the *path* is the contract worth
	// asserting and the origin is deployment config. Re-point it at the API to follow it.
	const variant = await page.request.get(atApi(variantUrl as string));
	expect(variant.status(), `${key} variant playlist`).toBe(200);
	const variantBody = await variant.text();
	expect(variantBody).toContain("#EXTINF");

	// 3. A real segment — the assertion this whole fixture change exists for. Not a URL,
	//    not a reason: the actual bytes, checked for the MPEG-TS sync byte (0x47).
	const segmentUrl = variantBody
		.split("\n")
		.find((l) => l.trim() && !l.startsWith("#"))
		?.trim();
	expect(segmentUrl, `${key} variant lists no segment`).toBeTruthy();
	const segment = await page.request.get(segmentUrl as string);
	expect(segment.status(), `${key} segment`).toBe(200);
	const bytes = await segment.body();
	expect(bytes.length, `${key} segment is empty`).toBeGreaterThan(1000);
	expect(bytes[0], `${key} segment is not MPEG-TS (no 0x47 sync byte)`).toBe(0x47);
}

/** Follow the audio redirect and confirm real MP3 bytes come back. */
async function expectAudioBytes(page: Page, key: string): Promise<void> {
	const item = await mediaItem(page, key);
	expect(item?.transcoding?.status, `${key} transcode status`).toBe("completed");
	expect(
		item?.transcoding?.outputFileUrl,
		`${key} withheld its audio from an entitled viewer`,
	).toBeTruthy();

	// The endpoint 302s to the stored object (signed, in S3 mode); the request follows it.
	const res = await page.request.get(audioUrl(key, item?.id as number));
	expect(res.status(), `${key} audio`).toBe(200);
	const bytes = await res.body();
	expect(bytes.length, `${key} audio is empty`).toBeGreaterThan(1000);
	// An MP3 starts with either an ID3 tag or a frame-sync word (0xFF 0xEx/0xFx).
	const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
	const isFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
	expect(isId3 || isFrameSync, `${key} audio is not MP3`).toBe(true);
}

/**
 * The negative, and the sharper of the two: a denied viewer gets no pointer at the media
 * *and* cannot reach it by constructing the URL themselves. The second half is the one
 * that matters — withholding a URL is not access control if the endpoint serves anyone
 * who guesses it, and guessing is trivial (the content item id is in the same response).
 */
async function expectMediaWithheld(page: Page, key: string): Promise<void> {
	const item = await mediaItem(page, key);
	// The item id survives — it isn't the deliverable. Every URL to the payload does not.
	expect(item?.id, `${key} should still expose its content item id`).toBeTruthy();
	expect(item?.transcoding?.hlsManifestUrl ?? null, `${key} leaked an HLS URL`).toBeNull();
	expect(item?.transcoding?.outputFileUrl ?? null, `${key} leaked an audio URL`).toBeNull();

	for (const url of [hlsUrl(key, item?.id as number), audioUrl(key, item?.id as number)]) {
		const res = await page.request.get(url);
		expect(res.status(), `${key} served ${url} to a denied viewer`).toBe(403);
	}
}

test.beforeAll(async () => {
	// This hook shells out to two Bun processes and runs a real ffmpeg transcode. That is
	// ~2s on a development machine and far more on a shared 2-core runner, where every
	// `bun run` pays workspace startup and ffmpeg has no cores to spare — it exceeded
	// Playwright's 30s default on CI while passing locally every time, and a timed-out
	// reset leaves a HALF-RESET fixture, so the next thing you see is `rung 1` failing on
	// a locked heading that never rendered. The visible failure was three tests away from
	// its cause. The budget matches the webServer timeouts in playwright.config.ts, which
	// are generous for the same reason.
	test.setTimeout(180_000);

	// Reset to the floor through the canonical script — this is what makes re-runs and
	// retries deterministic. The viewer's session survives (reset never touches sessions).
	execFileSync("bun", ["run", "db:gauntlet", "--ensure-viewer"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	// The reset deletes the fixture's posts and their content items, so real media has to
	// be re-attached every time — and through the real transcode job, not a staged row.
	execFileSync("bun", ["run", "db:gauntlet:media"], { cwd: REPO_ROOT, stdio: "inherit" });

	// Ask ffmpeg directly rather than inferring from the API. Inferring is what let a
	// broken assertion read as a passing skip the first time this was written: the media
	// seeded fine, the probe looked in the wrong place, and the walk went green having
	// checked nothing. With ffmpeg present the byte assertions RUN — they never skip.
	mediaSeeded = (() => {
		try {
			execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	})();
	if (!mediaSeeded) {
		console.warn(
			"[gauntlet] ffmpeg not installed — the fixture has no real media, so the delivery\n" +
				"[gauntlet] byte assertions are SKIPPED. Install ffmpeg to cover them.",
		);
	}

	for (const post of GAUNTLET_POSTS) {
		// The fixture's subject is the WORK — the staircase this walks is an access
		// staircase, and access lives on the Work. Each also has an announcement post.
		const res = await fetch(`${API_URL}/api/content/works/${post.slug}`);
		if (!res.ok) throw new Error(`Fixture Work ${post.slug} not reachable: ${res.status}`);
		const body = (await res.json()) as { work: { id: number } };
		workIds[post.key] = body.work.id;
	}
});

/**
 * A bare `/works/{slug}` settles to the canonical `/works/{slug}-{publicId}`, and that
 * redirect changes the route param — which used to re-trigger the page's fetch effect,
 * so every visit of this shape paid for TWO round trips with a `setLoading(true)` between
 * them that tore the rendered page back down to a spinner.
 *
 * Nothing asserted it, and on a fast machine nothing showed it. On a slow CI runner it is
 * the difference between one render and two, mid-assertion — the most likely explanation
 * for this walk failing on `Locked ·` not being visible while passing on a plain re-run of
 * the same commit. Counting the requests is the only way this stays fixed.
 */
test("a bare work URL settles to canonical without fetching the Work twice", async ({ page }) => {
	const spec = gauntletPost("G1");
	const detailCalls: string[] = [];
	page.on("request", (r) => {
		const u = new URL(r.url());
		// The detail endpoint only — not /transcoding, /audio, /hls or the asset routes.
		if (/^\/api\/content\/works\/[^/]+$/.test(u.pathname)) detailCalls.push(u.pathname);
	});

	await page.goto(`/works/${spec.slug}`);
	await expect(page.getByRole("heading", { name: spec.title })).toBeVisible();
	// The URL settled…
	await expect(page).toHaveURL(new RegExp(`/works/${spec.slug}-\\d+$`));
	// …and settling cost nothing.
	expect(detailCalls).toHaveLength(1);
});

/** The post page carries the same canonicalisation, and had the same bug — worse, because
 *  its effect fetches the post AND its comments, so a bare URL cost four requests. */
test("a bare post URL settles to canonical without fetching the post twice", async ({ page }) => {
	const bare = `${gauntletPost("G1").slug}-post`;
	const calls: string[] = [];
	page.on("request", (r) => {
		const u = new URL(r.url());
		// Detail and comments both — the whole cost of arriving, not just one leg of it.
		if (/^\/api\/content\/posts\/[^/]+(\/comments)?$/.test(u.pathname)) calls.push(u.pathname);
	});

	await page.goto(`/posts/${bare}`);
	await expect(page).toHaveURL(new RegExp(`/posts/${bare}-\\d+$`));
	// One detail + one comments fetch, not two of each.
	expect(calls).toHaveLength(2);
});

test("rung 1 — the floor: free streams, everything else reads locked", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	// Following nobody, the feed short-circuits to [] — the gauntlet posts must not leak in.
	await page.goto("/feed");
	await expect(page.getByText(gauntletPost("G1").title)).toBeHidden();

	await expectPostUnlocked(page, "G1");
	await expectPostLocked(page, "G2");
	await expectPostLocked(page, "G3");

	// The exact number, at the one state where it's unambiguous: holding nothing, G2's
	// first Seed rung asks for exactly one more. Pinning the arithmetic here is what stops
	// the panel drifting back to quoting the THRESHOLD instead of the gap.
	await page.goto(`/works/${gauntletPost("G2").slug}`);
	await expect(page.getByRole("link", { name: /^Unlock with 1 more Seed to / })).toBeVisible();

	await expectStaircase(page, "Free, unfollowed");

	if (mediaSeeded) {
		// "Free streams" as a claim about BYTES, not about a reason string: G1's video
		// really plays for a viewer holding nothing, and G3's audio really doesn't.
		await expectVideoBytes(page, "G1");
		await expectMediaWithheld(page, "G3");
	}
	expect(errors).toEqual([]);
});

test("rung 2 — follow: the feed fills, access does not change", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	await page.goto(`/${GAUNTLET_CREATOR_USERNAME}`);
	await page.getByRole("button", { name: "Follow", exact: true }).click();
	await expect(page.getByRole("button", { name: "Following" })).toBeVisible();

	await page.goto("/feed");
	// The feed interleaves posts and releases, so a Work AND the post announcing it can
	// both appear — `.first()` rather than a strict single match. Whether the feed should
	// collapse an announcement into the release it announces is a real question, and not
	// one this rung is asking.
	await expect(page.getByText(gauntletPost("G1").title).first()).toBeVisible();

	// The negative assertion this rung exists for: following is not entitlement.
	// The row must be IDENTICAL to the unfollowed floor.
	await expectStaircase(page, "Free, following");
	expect(errors).toEqual([]);
});

test("rung 3 — comment on the free post", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	// Comments still hang off the POST — a Work carries no comment thread yet, and the
	// fixture gives every Work an announcement post at `<slug>-post`.
	await page.goto(`/posts/${gauntletPost("G1").slug}-post`);
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
		`${API_URL}/api/content/posts/${gauntletPost("G2").slug}-post/comments`,
		{
			data: { body: "Commenting on a post I cannot read (recorded gauntlet behavior)." },
			headers: { Origin: "http://localhost:4173" },
		},
	);
	expect(res.status(), "commenting on an inaccessible post (recorded behavior)").toBe(201);

	expect(errors).toEqual([]);
});

// ── A Badge opens nothing ───────────────────────────────────────────────────
/**
 * 🚨 Four tests climbed Root → Blossom here until 2026-08-12, each asserting that exactly
 * one more post unlocked. **Anthers Gates are retired**, so the replacement asserts the
 * opposite and is the more important of the two: the top Badge, held for real, changes
 * nothing about any Work.
 *
 * Worth walking in the browser rather than trusting the resolver test, because the
 * resolver can no longer even see the count — the risk that remains is a *surface* that
 * still offers a Badge as a way in.
 */
test("rung 4 — Blossom unlocks nothing; a Badge is standing, not access", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);
	hop("--anthers-seeds", "4");

	await expectPostUnlocked(page, "G1");
	await expectPostLocked(page, "G2");
	await expectStaircase(page, "Blossom, no Seeds given");

	// And no surface offers the Badge as a route in. The unlock control on a gated Work
	// must name the creator, never Anthers.
	await page.goto(`/works/${gauntletPost("G2").slug}`);
	await expect(page.getByRole("link", { name: /^Unlock with 1 more Seed to / })).toBeVisible();
	await expect(page.getByRole("button", { name: /Seed to Anthers/ })).toBeHidden();

	if (mediaSeeded) await expectMediaWithheld(page, "G3");
	expect(errors).toEqual([]);
});

// ── The Seed ladder, through the real Give-Seeds control ─────────────────────
test("rung 5 — Seed budget alone unlocks nothing", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);
	// Enough budget for the whole ladder. Holding budget is not giving it — the staircase
	// must still read exactly as it did before.
	hop("--seed-budget", String(SEED_PRICE * SEED_RUNGS[SEED_RUNGS.length - 1]));
	await expectStaircase(page, "Blossom, no Seeds given");
	expect(errors).toEqual([]);
});

/**
 * One click per Seed: the stepper steps whole Seeds ($3), so every state on the walk is
 * reached by exactly one more click than the one before it.
 *
 * ⭐ **The ladder is sparse (`SEED_RUNGS` = 1, 2, 3, 5, 7), so some clicks land BETWEEN
 * rungs and must unlock nothing.** That is the point of walking every count rather than
 * only the rungs: a surface that compared a viewer's position in the ladder to the rung's
 * position would open a post at 4 Seeds, and only a between-state can catch it.
 */
for (const [i, seeds] of SEED_WALK.entries()) {
	const rungIndex = SEED_RUNGS.indexOf(seeds as (typeof SEED_RUNGS)[number]);
	const unlocked = rungIndex >= 0 ? `G${2 + rungIndex}` : null;
	// The next rung ABOVE this Seed count, whether or not the count is itself a rung —
	// one expression covering both the on-rung and between-rung states. Null at the top
	// of the ladder, where there is nothing left to stay locked.
	const nextIndex = SEED_RUNGS.findIndex((t) => t > seeds);
	const stillLocked = nextIndex >= 0 ? `G${2 + nextIndex}` : null;
	const clicks = seeds - (SEED_WALK[i - 1] ?? 0);

	test(`rung 5 — at ${seeds} Seed${seeds === 1 ? "" : "s"} given: ${unlocked ? "exactly one more post unlocks" : "nothing new unlocks (between rungs)"}`, async ({
		page,
	}) => {
		const errors = trackErrorsStrict(page, ALLOWED);

		await page.goto(`/${GAUNTLET_CREATOR_USERNAME}?tab=badges`);
		for (let n = 0; n < clicks; n++) {
			await page.getByRole("button", { name: "More seeds" }).click();
		}
		await page.getByRole("button", { name: `Give $${(SEED_PRICE * clicks).toFixed(2)}` }).click();
		// The give settles when the button returns to its resting label.
		await expect(page.getByRole("button", { name: "Give Seeds" })).toBeVisible();

		if (unlocked) await expectPostUnlocked(page, unlocked);
		if (stillLocked) await expectPostLocked(page, stillLocked);
		await expectStaircase(page, EXPECTED_STAIRCASE[3 + i].state);
		expect(errors).toEqual([]);
	});
}

test("rung 5 — the ratchet: the stepper cannot walk back down", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);
	await page.goto(`/${GAUNTLET_CREATOR_USERNAME}?tab=badges`);
	// The full ladder is committed; within the cycle the control's floor IS that amount.
	await expect(page.getByRole("button", { name: "Fewer seeds" })).toBeDisabled();
	expect(errors).toEqual([]);
});

// ── The purchase rung ────────────────────────────────────────────────────────
test("rung 6 — purchase unlocks the download, and only the purchase does", async ({ page }) => {
	const errors = trackErrorsStrict(page, ALLOWED);

	// Even from the very top of the ladder, the purchase rung still quotes its price — asserted by
	// every row so far. Now the hop writes the completed purchase the payment webhook
	// would have written (the real charge belongs to the Stripe walk).
	hop("--purchase", gauntletPost(BUY).slug);

	await expectStaircase(page, "+ purchased");

	// The post page must now offer the download instead of a checkout.
	await page.goto(`/works/${gauntletPost(BUY).slug}`);
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
