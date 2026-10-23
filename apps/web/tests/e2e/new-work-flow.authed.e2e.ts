// SPDX-License-Identifier: Apache-2.0
/**
 * The New Work flow, walked end to end: name, category, type, delivery, then the Work's own
 * page. The type choice creates the draft, so the walk also proves the row exists before the
 * delivery step and that finishing lands on the Work by its own address.
 *
 * The screenshots are the review surface for the flow's shape; the assertions are what keeps
 * the shape honest.
 */

import { mkdirSync } from "node:fs";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const SHOTS = "/tmp/opencode/new-work-flow";
const RUN = `Flow walk ${Date.now()}`;
const TITLE_PREFIX = "Flow walk ";
let session = "";

// The suite shares `media_fixture` with every other walk, and a leftover service Work
// would widen the Works table's type filter for whoever reads it next (`studio-works-table`
// asserts that `service` isolates exactly its own row). Sweep by the run's own prefix.
test.afterAll(async () => {
	if (!session) return;
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works } = (await res.json()) as { works: { id: number; title: string }[] };
	for (const work of works.filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${work.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});

test("the New Work flow walks name, category, type and delivery", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	mkdirSync(SHOTS, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.goto("/studio/works/new");
	await expect(page.getByRole("heading", { name: "New Work" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Name this Work" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
	await page.screenshot({ path: `${SHOTS}/01-name.png`, fullPage: true });

	const title = `${RUN} screenshot`;
	await page.getByPlaceholder("A name").fill(title);
	await page.getByRole("button", { name: "Continue" }).click();

	await expect(page.getByRole("heading", { name: "What kind of thing is it?" })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Digital/ })).toContainText("Video");
	await page.screenshot({ path: `${SHOTS}/02-category.png`, fullPage: true });

	await page.getByRole("button", { name: /^Digital/ }).click();
	await expect(page.getByRole("heading", { name: "Choose the type" })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Comic/ })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/03-type.png`, fullPage: true });

	await page.getByRole("button", { name: /^Video/ }).click();
	await expect(page.getByRole("heading", { name: "How does it reach people?" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText("Stream on Anthers", { exact: true })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/04-delivery.png`, fullPage: true });

	await page.getByText("Stream and Download", { exact: true }).click();
	await expect(page.getByText("Selected")).toHaveCount(1);
	await expect(page.locator("label").filter({ hasText: "Stream on Anthers" })).not.toContainText(
		"Selected",
	);
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/05-delivery-chosen.png`, fullPage: true });

	await page.getByRole("button", { name: "Edit Your New Work" }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: title })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/06-work-page.png`, fullPage: true });

	// The pencil swaps the same card for the manager; the page below does not move.
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await expect(page.getByRole("heading", { name: "Media Management" })).toBeVisible();
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/09-media-manager-delivery.png`, fullPage: true });

	await page.getByRole("tab", { name: "Source" }).click();
	await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/10-media-manager-source.png`, fullPage: true });

	await page.getByRole("tab", { name: "Thumbnail" }).click();
	await expect(page.getByRole("tab", { name: "Thumbnail" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/11-media-manager-thumbnail.png`, fullPage: true });

	await page.getByRole("tab", { name: "Versions" }).click();
	await expect(page.getByRole("tab", { name: "Versions" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/12-media-manager-versions.png`, fullPage: true });
});

test("a game's empty media card carries the build intake", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	mkdirSync(SHOTS, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.goto("/studio/works/new");
	await page.getByPlaceholder("A name").fill(`${RUN} game`);
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("button", { name: /^Digital/ }).click();
	await page.getByRole("button", { name: /^Game/ }).click();
	await expect(page.getByRole("heading", { name: "How does it reach people?" })).toBeVisible();
	await page.getByRole("button", { name: "Edit Your New Work" }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	await expect(page.getByRole("heading", { name: "Downloadable Builds" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Hosted Build" })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/13-game-intake.png`, fullPage: true });

	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await page.getByRole("tab", { name: "Source" }).click();
	await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/14-game-manager-source.png`, fullPage: true });
});

test("the Non-Digital branch stops at fulfillment", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	mkdirSync(SHOTS, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.goto("/studio/works/new");
	await page.getByPlaceholder("A name").fill(`${RUN} service`);
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("button", { name: /^Non-Digital/ }).click();

	await expect(page.getByRole("heading", { name: "Choose the type" })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Service/ })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/07-goods-types.png`, fullPage: true });

	await page.getByRole("button", { name: /^Service/ }).click();
	await expect(page.getByRole("heading", { name: "How does it reach people?" })).toBeVisible();
	await expect(page.getByText("Sold and Fulfilled", { exact: true })).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/08-goods-delivery.png`, fullPage: true });

	await page.getByRole("button", { name: "Edit Your New Work" }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
});
