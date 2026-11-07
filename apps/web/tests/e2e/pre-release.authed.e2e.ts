// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's pre-release page — public while the Work is not (Parker, 2026-11-07).
 *
 * The editor sets a date before the release; at that date the page, its preview media and
 * its listing become public, while buying, downloading, streaming and reviews stay closed.
 * The walk proves the three things a reader would notice: the coming-soon card instead of a
 * buy door, the release date when one is scheduled, and a 404 once the date is cleared.
 */
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { API_URL, expect, signInAsCreator, test, WEB_ORIGIN } from "./fixtures";

const STEM = `Pre-release ${Date.now()}`;
const CREDIT = [{ role: "Made by", contributor: "Fixture Creator", types: ["created"] }];
const created: number[] = [];
let creatorToken = "";

function api(token: string, path: string, init: RequestInit = {}) {
	return fetch(`${API_URL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${token}`,
			...init.headers,
		},
	});
}

/** A local datetime string the input accepts, `n` days from now. */
function localInput(days: number): string {
	const date = new Date(Date.now() + days * 24 * 60 * 60_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test.afterAll(async () => {
	if (!creatorToken) return;
	for (const id of created) {
		await api(creatorToken, `/api/content/works/${id}?force=1`, { method: "DELETE" }).catch(
			() => {},
		);
	}
});

test("a creator opens a pre-release page, and a reader meets a coming-soon Work", async ({
	page,
	context,
	browser,
}) => {
	const token = await signInAsCreator(context);
	creatorToken = token;
	const createdRes = await api(token, "/api/content/works", {
		method: "POST",
		body: JSON.stringify({
			type: "game",
			title: STEM,
			credits: CREDIT,
			maturityRows: rowsRatedAs("general"),
			access: [{ threshold: 0, allow: true, price: "5.00" }],
		}),
	});
	expect(createdRes.status, "creating the pre-release Work").toBe(201);
	const work = (
		(await createdRes.json()) as {
			work: { id: number; publicId: number; slug: string };
		}
	).work;
	created.push(work.id);

	// The release date is scheduled first, so the page has a date to promise.
	const scheduled = await api(token, `/api/content/works/${work.id}`, {
		method: "PATCH",
		body: JSON.stringify({
			scheduledReleaseAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
		}),
	});
	expect(scheduled.status, "scheduling the release").toBe(200);

	// The editor's own Release field carries the pre-release date beside the release date.
	await page.goto(`/works/${work.slug}-${work.publicId}`);
	await page.getByRole("button", { name: "Edit Release" }).click();
	const preRelease = page.getByLabel("Pre-Release Date");
	await expect(preRelease).toBeVisible();
	await preRelease.fill(localInput(-1));
	await page.getByRole("button", { name: "Save Release" }).click();

	// The read line now says the page is coming soon, rather than unreleased.
	await expect(page.getByText(/Coming soon/)).toBeVisible({ timeout: 15_000 });

	// A reader with no session meets the page and the coming-soon card, not a buy door.
	const visitorContext = await browser.newContext();
	const visitor = await visitorContext.newPage();
	try {
		await visitor.goto(`/works/${work.slug}-${work.publicId}`);
		await expect(visitor.getByRole("heading", { name: STEM, level: 1 })).toBeVisible({
			timeout: 15_000,
		});
		await expect(visitor.getByText(/Coming soon, available on/)).toBeVisible();
		await expect(visitor.getByText("$5.00 when it opens.")).toBeVisible();
		await expect(visitor.getByRole("button", { name: /Add to Cart|Buy Now/ })).toHaveCount(0);
		await expect(visitor.getByText(/Download$/)).toHaveCount(0);

		// Reviews are closed with a reason of their own.
		await visitor.getByRole("tab", { name: "Reviews" }).click();
		await expect(visitor.getByText(/This Work isn't out yet/)).toBeVisible();

		// Clearing the date returns the page to private.
		const cleared = await api(token, `/api/content/works/${work.id}`, {
			method: "PATCH",
			body: JSON.stringify({ preReleaseAt: null }),
		});
		expect(cleared.status, "clearing the pre-release date").toBe(200);
		await visitor.goto(`/works/${work.slug}-${work.publicId}`);
		await expect(visitor.getByRole("heading", { name: "Not Found" })).toBeVisible();
	} finally {
		await visitorContext.close();
	}
});
