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
import { expect, signInAsMediaFixture, test } from "./fixtures";

const SHOTS = "/tmp/opencode/new-work-flow";

test("the New Work flow walks name, category, type and delivery", async ({ page, context }) => {
	await signInAsMediaFixture(context);
	mkdirSync(SHOTS, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.goto("/studio/works/new");
	await expect(page.getByRole("heading", { name: "New Work" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Name this Work" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
	await page.screenshot({ path: `${SHOTS}/01-name.png`, fullPage: true });

	const title = `Screenshot draft ${Date.now()}`;
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
});

test("the Non-Digital branch stops at fulfillment", async ({ page, context }) => {
	await signInAsMediaFixture(context);
	mkdirSync(SHOTS, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.goto("/studio/works/new");
	await page.getByPlaceholder("A name").fill(`Service draft ${Date.now()}`);
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
