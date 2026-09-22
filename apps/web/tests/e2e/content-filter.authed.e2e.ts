// SPDX-License-Identifier: Apache-2.0
/**
 * A reader's filter by kind of content, walked in a browser: set Violence to Blur in Settings and
 * a creator's Work marked with violence is covered on their profile, naming Violence; set it to
 * Hide and the Work is gone, while one marked Not in It stays uncovered throughout.
 *
 * 🚨 **The API tests cannot see the browser half.** A blur is the browser's job, from the rows the
 * reader's copy of a Work carries, so a card that ignored them would pass every route test and
 * show the reader exactly what they asked to have covered.
 *
 * The Works are made by `media_fixture`, which nothing else resets, and read by the gauntlet
 * viewer the `authed` project signs in as. The viewer's setting is put back afterward, since other
 * walks share the account.
 */

import { gauntletHandle } from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { profileUrl } from "@anthers/web-shared/profile";
import type { BrowserContext } from "@playwright/test";
import {
	API_URL,
	AUTH_STATE_PATH,
	CREATED_CREDIT,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE_PREFIX = "Filter walk ";
const VIOLENT = `${TITLE_PREFIX}the fight ${Date.now()}`;
const GENTLE = `${TITLE_PREFIX}the picnic ${Date.now()}`;

let creatorContext: BrowserContext | null = null;
let creatorSession = "";
let creatorProfile = "";

function asCreator(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${API_URL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${creatorSession}`,
			Origin: WEB_ORIGIN,
			...init.headers,
		},
	});
}

async function sweep(): Promise<void> {
	if (!creatorSession) return;
	const { works } = (await (await asCreator("/api/content/works")).json()) as {
		works: Array<{ id: number; title: string }>;
	};
	for (const w of works.filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await asCreator(`/api/content/works/${w.id}?force=1`, { method: "DELETE" });
	}
}

/** A released piece of writing, rated through the matrix. */
async function release(title: string, rows: Record<string, string>): Promise<void> {
	const created = await asCreator("/api/content/works", {
		method: "POST",
		body: JSON.stringify({
			type: "text",
			title,
			bodyHtml: "<p>A walk.</p>",
			maturityRows: rows,
			streamEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
			// Release refuses a Work whose credits name no human (`credits_creator_required`).
			credits: CREATED_CREDIT,
		}),
	});
	expect(created.status).toBe(201);
	const { work } = (await created.json()) as { work: { id: number } };
	const released = await asCreator(`/api/content/works/${work.id}`, {
		method: "PATCH",
		body: JSON.stringify({ visibility: "released" }),
	});
	expect(released.status).toBe(200);
}

test.afterAll(async ({ browser }) => {
	await sweep();
	await creatorContext?.close();
	// Put the shared viewer's setting back, whatever the walk got to.
	const viewer = await browser.newContext({ storageState: AUTH_STATE_PATH });
	await viewer.request.patch(`${API_URL}/api/accounts/me/content-preferences`, {
		headers: { Origin: WEB_ORIGIN },
		data: { notes: { violence: "show" } },
	});
	await viewer.close();
});

test("a reader who blurs or hides violence meets it covered, then not at all", async ({
	page,
	browser,
}) => {
	creatorContext = await browser.newContext();
	creatorSession = await signInAsMediaFixture(creatorContext);
	// The profile URL is the issued handle — the name this spec asked for is not it
	// (`media_fixture` respells under the handle rules), so resolve rather than type it.
	creatorProfile = profileUrl(await gauntletHandle(API_URL, MEDIA_FIXTURE_USERNAME));
	await sweep();
	await release(VIOLENT, { ...rowsRatedAs("general"), violence: "general" });
	await release(GENTLE, rowsRatedAs("general"));

	const violence = async (choice: "Hide" | "Blur" | "Show") => {
		// The violence control is on the Content & Safety tab.
		await page.goto("/settings?tab=content");
		const control = page.getByRole("group", { name: "Violence", exact: true });
		await control.getByRole("button", { name: choice, exact: true }).click();
		await expect(control.getByRole("button", { name: choice, exact: true })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	};
	const card = (title: string) => page.locator(".card").filter({ hasText: title });

	await violence("Blur");
	await page.goto(creatorProfile);
	// Covered, and the cover names the kind of content rather than the rating, which is General.
	await expect(card(VIOLENT)).toContainText("Violence");
	await expect(card(VIOLENT)).toContainText("Show anyway");
	await expect(card(GENTLE)).toBeVisible();
	await expect(card(GENTLE)).not.toContainText("Show anyway");

	await violence("Hide");
	await page.goto(creatorProfile);
	await expect(card(GENTLE)).toBeVisible();
	await expect(card(VIOLENT)).toHaveCount(0);

	await violence("Show");
});
