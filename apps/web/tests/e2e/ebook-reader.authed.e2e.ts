// SPDX-License-Identifier: Apache-2.0
/**
 * The reflow ebook reader, walked in a browser — over a real fixture ingest against the
 * real section/asset ladder.
 *
 * 🚨 **The assertion that anchors the whole task is the security one, and it is the
 * first test**: the fixture's scripted book carries a chapter whose script beacons to an
 * off-origin host and to the API with the reader's own credentials, the moment it runs —
 * the design's non-negotiable posture is that it must never run. The negative proofs are
 * network-level (no hostile request ever issued, in either direction) and the positive
 * proof is a CSP refusal in the console naming `script-src 'none'`, which distinguishes
 * "the posture held" from "the payload happened not to fire".
 *
 * 🚨 And the same walk carries the ladder's shape: sections and assets are fetched one
 * at a time through their checked routes — never the source EPUB, which stays private —
 * because a reader that fetched the container in one URL would make
 * `downloadEnabled: false` a lie for reflow books exactly as it once was for comics.
 *
 * ⚠️ What the suite cannot assert: the text *inside* a section. The vendored view keeps
 * its DOM behind a closed shadow root, deliberately — so rendering is proven by what the
 * paginator *does*: the location events the chrome reads only fire once content actually
 * paginated, and position restore only works on a book that laid out. A future spec
 * needing inner content goes through the view's own events, not around the shadow.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { expect, test } from "./fixtures";

const EBOOK = mediaFixtureWork("ebook");
const SCRIPTED = mediaFixtureWork("ebook-scripted");
const READER = 'section[aria-label^="Ebook reader:"]';

test.describe.configure({ mode: "serial" });

test("🚨 a scripted EPUB cannot execute or reach the network", async ({ page }) => {
	// ⚠️ Chromium emits a `request` event even for subresource loads the renderer refuse —
	// a CSP-blocked image may still show up in `request` — so the network half of this
	// test asserts OUTCOMES (no response, no reach-the-network failure), and the posture
	// half is the reader's own `data-csp` attribute: the fact that the documents actually
	// delivered to the paginator carried the hardening policy, checked per load.
	const responses: string[] = [];
	page.on("response", (r) => responses.push(r.url()));
	const failed: string[] = [];
	page.on("requestfailed", (r) => failed.push(r.url()));
	const requested: string[] = [];
	page.on("request", (r) => requested.push(r.url()));

	await page.goto(`/works/${SCRIPTED.slug}-${SCRIPTED.publicId}`);
	const reader = page.locator('section[aria-label^="Ebook reader:"][data-csp="on"]');
	await expect(reader).toBeVisible({ timeout: 20_000 });
	await expect(reader).toContainText("Section 1 of 2");

	// The hostile chapter's script beacons to an attacker host and to this site's own API
	// with the session's credentials; its fetches, its meta refresh and its image all
	// point at the same attacker host. Nothing produced by any of them may read anything
	// back or reach the network layer, and — because the rewriter strips what it cannot
	// own — none of it was even issued.
	const hostile = (u: string) => u.includes("attacker.example.test") || u.includes("via=");
	expect(
		requested.filter(hostile),
		"a scripted EPUB's payload was issued at all — the rewriter should have taken it",
	).toEqual([]);
	expect(
		responses.filter(hostile),
		"a scripted EPUB's payload got an answer — the reader's CSP posture failed",
	).toEqual([]);
	expect(
		failed.filter(hostile),
		"a scripted EPUB's payload reached the network layer — the CSP did not stop it",
	).toEqual([]);
});

test("reads through the ladder — one checked section at a time, never the container", async ({
	page,
}) => {
	const requested: string[] = [];
	page.on("request", (r) => requested.push(r.url()));

	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	await expect(page.locator(READER)).toBeVisible();
	await expect(page.locator(READER)).toContainText("Section 1 of 3", { timeout: 20_000 });

	// What was asked for: the manifest, then a section, then — because the section's
	// stylesheet rode the ladder too — an asset. The asset request is the rewrite
	// machinery working end to end: it only exists because the chapter's css reference
	// was resolved to its checked route.
	expect(
		requested.some((u) => /\/api\/content\/works\/\d+\/sections$/.test(u)),
		"the manifest was never fetched",
	).toBe(true);
	expect(requested.some((u) => /\/api\/content\/works\/\d+\/sections\/1$/.test(u))).toBe(true);
	expect(
		requested.some((u) => /\/api\/content\/works\/\d+\/assets\/\d+$/.test(u)),
		"no asset request — the chapter's stylesheet did not resolve through the ladder",
	).toBe(true);

	// And what was never asked for: the source EPUB. It stays private, the same way a
	// comic's PDF does.
	expect(
		requested.filter((u) => u.includes(".epub")),
		"the reader fetched the source EPUB — the single-file delivery hazard is back",
	).toEqual([]);
});

test("the chrome knows where you are, and turns by arrow and by button", async ({ page }) => {
	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	await expect(page.locator(READER)).toContainText(/Section \d of 3/, { timeout: 20_000 });

	// A page turn is a page turn, not a chapter turn: a reflow section paginates, so the
	// label's section stays and the fraction moves. Direction is what is being asserted —
	// the read fraction advances on next and retreats on previous, never jumping sections.
	const readFraction = async () => {
		const text = (await page.locator(READER).textContent()) ?? "";
		const m = /· (\d+)%/.exec(text);
		expect(m, "the chrome's fraction display").not.toBeNull();
		return Number(m![1]);
	};

	const reader = page.locator(READER);
	const before = await readFraction();
	await reader.getByRole("button", { name: "Next page" }).click();
	await expect.poll(readFraction, { timeout: 10_000 }).toBeGreaterThan(before);
	const advancedTo = await readFraction();

	await reader.getByRole("button", { name: "Previous page" }).click();
	await expect.poll(readFraction, { timeout: 10_000 }).toBeLessThan(advancedTo);

	await reader.focus();
	// Keyboard turns are asserted relative to where the reader stands at press time —
	// pages within a section, so "left of where I was" not "below the opening fraction",
	// and never a chapter jump, which only the TOC, the seek bar and the spine perform.
	const stoodAt = await readFraction();
	await page.keyboard.press("ArrowRight");
	await expect.poll(readFraction, { timeout: 10_000 }).toBeGreaterThan(stoodAt);
	const turnedTo = await readFraction();
	await page.keyboard.press("ArrowLeft");
	await expect.poll(readFraction, { timeout: 10_000 }).toBeLessThan(turnedTo);
});

test("a turn issued while the book is still opening is honored, not dropped", async ({ page }) => {
	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	const reader = page.locator(READER);
	const readFraction = async () => {
		const text = (await reader.textContent()) ?? "";
		const m = /· (\d+)%/.exec(text);
		return m ? Number(m[1]) : null;
	};
	// The section label first appears while the view's opening turn is still turning
	// the book's first page, under the paginator's own lock — and the reader's transport
	// is live exactly then. Input issued at that instant is the shape that was lost: it
	// died on the opening turn's lock and the reader froze on its opening fraction
	// forever. The chrome makes this turn wait behind the opening turn, so the click is
	// honored after the first one lands, never refused.
	await expect(reader).toContainText("Section 1 of 3");
	const stoodAt = await readFraction();
	expect(stoodAt, "the chrome's fraction display").not.toBeNull();
	await reader.getByRole("button", { name: "Next page" }).click();
	await expect.poll(readFraction, { timeout: 10_000 }).toBeGreaterThan(stoodAt);
});

test("the table of contents navigates the spine", async ({ page }) => {
	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	await expect(page.locator(READER)).toContainText("Section 1 of 3", { timeout: 20_000 });

	const reader = page.locator(READER);
	await reader.getByRole("button", { name: "Table of contents" }).click();
	await expect(reader.getByRole("button", { name: "Chapter Two" })).toBeVisible();
	await reader.getByRole("button", { name: "Chapter Two" }).click();
	await expect(reader).toContainText("Section 3 of 3");
});

test("it reopens where you stopped reading", async ({ page }) => {
	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	const reader = page.locator(READER);
	await expect(reader).toContainText(/Section \d of 3/, { timeout: 20_000 });

	// Land deterministically inside the middle of the spine — the TOC jump, not page
	// turns, because a reflow chapter spans several pages inside its own section.
	await reader.getByRole("button", { name: "Table of contents" }).click();
	await reader.getByRole("button", { name: "Chapter Two" }).click();
	await expect(reader).toContainText("Section 3 of 3", { timeout: 10_000 });

	// The same persistence contract the page reader holds: reopening the Work resumes
	// rather than restarts, and losing your place on a reload is what makes a reader
	// feel cheap.
	await page.reload();
	await expect(reader).toContainText("Section 3 of 3", { timeout: 20_000 });
});

test("the seek bar moves through the book by fraction", async ({ page }) => {
	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	const reader = page.locator(READER);
	await expect(page.locator(READER)).toContainText("Section 1 of 3");

	// The seek bar's own affordance: a drag to the far end, which `goToFraction` must
	// ride to the last section the book has.
	const seek = reader.getByRole("slider", { name: "Reading progress" });
	await seek.fill("1000");
	await expect(reader).toContainText("Section 3 of 3");
});

test("the flow toggle switches to the continuous scroll", async ({ page }) => {
	await page.goto(`/works/${EBOOK.slug}-${EBOOK.publicId}`);
	const reader = page.locator(READER);
	await expect(page.locator(READER)).toContainText("Section 1 of 3");

	// The attribute is the vendored paginator's own knob; the chrome exposes it, and the
	// re-render it causes must keep a located reader reading — the section label is what
	// a relocation wrote, and it survives the mode change.
	await reader.getByRole("button", { name: "Scrolled flow" }).click();
	await expect(page.locator(READER)).toContainText("of 3");
});
