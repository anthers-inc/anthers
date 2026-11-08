// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's release warnings and the two setup checklists.
 *
 * 🚨 **No surface here is a second definition of "ready".** Each reads the same predicate as
 * the release refusal (`creditsMissing`, `!fromRows`, `fileMissing`, the creator's standing),
 * so a marker cannot say a Work is fine while the Release control refuses it. The warning
 * icons mark the tabs where a fix lives (Parker narrowed that pass to those three markers);
 * the floating card is the Work's overview, and the Studio's front door carries the creator's
 * own two conditions until they are met.
 *
 * A video Work with no file is the fixture because it trips all three Work conditions at
 * once: no created credit, an unanswered rating matrix, and no media.
 */
import type { Page } from "@playwright/test";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE = `Release warnings walk ${Date.now()}`;
const WARNING = "This is mandatory for release. Fill it in before the scheduled date.";

test.describe.configure({ mode: "serial" });

let session = "";
let workId = 0;
let publicId = 0;

async function api(path: string, init: RequestInit = {}) {
	return fetch(`${API_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			Origin: WEB_ORIGIN,
			Cookie: `session=${session}`,
		},
	});
}

/** Open the Work's editor — its own page, at the URL the create flow lands on. */
async function openEditor(page: Page, publicId: number): Promise<void> {
	await page.goto(`/studio/works/${publicId}/edit`);
	await expect(page).toHaveURL(/\/works\/[^/?]+$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: TITLE, exact: true })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	session = await signInAsMediaFixture(context);
	await context.close();

	const res = await api("/api/content/works", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "video", title: TITLE }),
	});
	expect(res.status, "creating the walk Work failed").toBe(201);
	const body = (await res.json()) as { work: { id: number; publicId: number } };
	workId = body.work.id;
	publicId = body.work.publicId;
});

test.afterAll(async () => {
	if (workId) await api(`/api/content/works/${workId}?force=1`, { method: "DELETE" });
});

test("an unfinished Work marks the tabs and the media area release still needs", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await openEditor(page, publicId);

	// Credits and Rating each carry the triangle and the sentence, as the tab's tooltip and
	// in its accessible name; the media area carries the same marker beside its pencil.
	await expect(page.getByRole("tab", { name: /Credits/ })).toHaveAttribute("title", WARNING);
	await expect(page.getByRole("tab", { name: /Rating/ })).toHaveAttribute("title", WARNING);
	await expect(page.getByTitle(WARNING), "the three release markers").toHaveCount(3);
	await expect(page.getByRole("tab", { name: /Warning: .*mandatory for release/ })).toHaveCount(2);
});

test("the Work checklist starts open, names what is missing, and gets out of the way", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await openEditor(page, publicId);

	const card = page.getByRole("complementary", { name: "Work Setup Checklist" });
	await expect(card, "the checklist opens without being asked for").toBeVisible();
	await expect(card.getByText("The media for the Work")).toBeVisible();
	await expect(card.getByText("At least one human credit")).toBeVisible();
	await expect(card.getByText("A full set of ratings")).toBeVisible();

	// It collapses to a button that keeps the progress visible, and opens again from it.
	await page.getByRole("button", { name: "Collapse the Work Setup Checklist" }).click();
	await expect(card).toBeHidden();
	const fab = page.getByRole("button", { name: /Open the Work Setup Checklist: \d+ of \d+ done/ });
	await expect(fab).toBeVisible();
	await fab.click();
	await expect(card).toBeVisible();

	// A Work-level row takes the creator to the control, and the card gets out of the way.
	await card.getByRole("button", { name: "A full set of ratings" }).click();
	await expect(page.getByRole("tab", { name: /Rating/ })).toHaveAttribute("aria-selected", "true");
	await expect(card).toBeHidden();

	// The media row opens the manager on the tab that holds this kind's file.
	await fab.click();
	await card.getByRole("button", { name: "The media for the Work" }).click();
	await expect(page.getByRole("heading", { name: "Media Management" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Source & Versions" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

test("a creator whose own setup is unfinished sees that checklist instead of the Work's", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	// The account is set up for publishing except for payouts. Answer the check directly so
	// the walk does not depend on the fixture's Stripe state.
	await page.route("**/api/payments/stripe/onboard", (route) =>
		route.fulfill({ json: { payoutsEnabled: false, onboardingComplete: false } }),
	);

	// The Studio's front door carries the onboarding card while setup is incomplete.
	await page.goto("/studio/works");
	await expect(page.getByRole("heading", { name: "Works" })).toBeVisible();
	const creatorCard = page.getByRole("region", { name: "Creator Setup Checklist" });
	await expect(creatorCard).toBeVisible();
	await expect(creatorCard.getByText("Allow ATProto creator permissions")).toBeVisible();
	await expect(creatorCard.getByText("Complete your Stripe Payout Setup")).toBeVisible();

	// The same draft Work shows that checklist, not its own, until the setup is done.
	await openEditor(page, publicId);
	const floatingCreator = page.getByRole("complementary", { name: "Creator Setup Checklist" });
	await expect(floatingCreator).toBeVisible();
	await expect(floatingCreator.getByText("The media for the Work")).toHaveCount(0);

	// With the payout answer complete, the same page switches to the Work's own checklist.
	await page.unroute("**/api/payments/stripe/onboard");
	await page.route("**/api/payments/stripe/onboard", (route) =>
		route.fulfill({ json: { payoutsEnabled: true, onboardingComplete: true } }),
	);
	await page.reload();
	const workCard = page.getByRole("complementary", { name: "Work Setup Checklist" });
	await expect(workCard).toBeVisible();
	await expect(workCard.getByText("The media for the Work")).toBeVisible();
});
