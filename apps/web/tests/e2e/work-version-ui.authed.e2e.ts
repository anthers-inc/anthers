// SPDX-License-Identifier: Apache-2.0
/**
 * A released Work's media manager offers a new version and does not offer removal.
 *
 * The seeded `media_fixture` video is a real released Work with a real source, so this is
 * the one state the flow's own test cannot reach without a full upload and release. The
 * test reads the owner's Catalog for the Work's durable address, opens its manager, and
 * checks the Original chip's menu: **Add a New Version…** is there, **Remove File** is not.
 */

import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { API_URL, expect, signInAsMediaFixture, test } from "./fixtures";

const SHOTS = "/tmp/opencode/new-work-flow";

test("a released Work offers a new version but not removal", async ({ page, context }) => {
	await signInAsMediaFixture(context);
	await page.setViewportSize({ width: 1440, height: 1000 });

	const catalog = await page.request.get(`${API_URL}/api/content/works`);
	expect(catalog.ok(), "the owner's Catalog should answer").toBe(true);
	const body = (await catalog.json()) as {
		works: { slug: string; publicId: number; visibility: string }[];
	};
	const seeded = mediaFixtureWork("video");
	const work = body.works.find((item) => item.slug === seeded.slug);
	expect(work, "the seeded video should be in the owner's Catalog").toBeTruthy();
	expect(work?.visibility).toBe("released");

	await page.goto(`/works/${work?.slug}-${work?.publicId}`);
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await page.getByRole("tab", { name: "Source" }).click();
	await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");

	await page.getByText("Original", { exact: true }).click();
	await expect(page.getByRole("button", { name: /Add a New Version/ })).toBeVisible();
	await expect(page.getByText("Remove File")).toHaveCount(0);
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/15-released-add-version.png`, fullPage: true });
});
