// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The handle door on `/subscribe` — the one where Anthers issues the identity.
 *
 * `/subscribe` is the single signup door and this spec's job, like its Bluesky sibling's, is
 * to keep it single. A third tab is exactly the change that grows a second way in by
 * accident: the 2026-08-17 consolidation deleted a Create Account card for that reason, and
 * the two doors it replaced had already drifted about terms and onboarding.
 *
 * ⭐ **This door asks for one field, and the reason is structural rather than aesthetic.** The
 * card sits above the Badge ladder, so a taller tab pushes the page down under whoever is
 * reading it — which is why the Bluesky panel lost its explanatory paragraph on 2026-08-24.
 * The address is still what mints the account; it is asked for on `/finish`, which already
 * has a face for exactly that.
 *
 * ⚠️ **What it cannot assert.** Creating an identity means creating one on a real server,
 * which no test may do. `playwright.config.ts` points the suite at `node.invalid`, and the
 * availability check is intercepted in the browser so these tests do not depend on which
 * names happen to be taken on the real node this week. What happens server-side — that
 * nothing is issued before an address is proved, and that a requested name is dropped when a
 * signup is resumed by address — is pinned in `pending-signup.test.ts` and
 * `hosted-accounts.test.ts`.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** The signup control at the top of the page; `/subscribe` renders two. See its sibling. */
const topSignup = (page: Page) => page.locator('[data-signup="top"]');

/** Answer the availability check without leaving the browser. */
async function stubAvailability(
	page: Page,
	answer: (name: string) => Record<string, unknown>,
): Promise<string[]> {
	const asked: string[] = [];
	await page.route("**/api/atproto/handle-available**", async (route) => {
		const name = new URL(route.request().url()).searchParams.get("name") ?? "";
		asked.push(name);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(answer(name)),
		});
	});
	return asked;
}

async function openHandleDoor(page: Page) {
	await topSignup(page).getByRole("tab", { name: "Handle", exact: true }).click();
}

test.describe("signing up with a handle Anthers issues", () => {
	test("the tab reveals the handle field, and email is still the default door", async ({
		page,
	}) => {
		await page.goto("/subscribe");

		// 🚨 **Wait for the tab before asserting the field is absent**, exactly as the Bluesky
		// spec does. The door is only drawn once `GET /api/atproto/config` answers, so on first
		// paint there are no tabs at all and nothing named "The handle you'd like" — which makes
		// a bare `toHaveCount(0)` pass for a reason that has nothing to do with which door is
		// selected.
		const handleTab = topSignup(page).getByRole("tab", { name: "Handle", exact: true });
		await expect(handleTab).toBeVisible();
		await expect(
			topSignup(page).getByLabel("The handle you'd like"),
			"email is the door a visitor meets; this is the third tab, not the default",
		).toHaveCount(0);

		await openHandleDoor(page);
		await expect(topSignup(page).getByLabel("The handle you'd like")).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /create my free account/i }),
			"the button should refuse until there is a name to ask for",
		).toBeDisabled();

		// ⭐ **The suffix is named before anything is typed.** Somebody picking a name is
		// picking a domain, and meeting that only once the name is accepted is meeting it too
		// late to have changed the choice. Matched loosely because this suite's suffix is the
		// test environment's, not production's.
		await expect(topSignup(page).getByText(/your handle will end in \./i)).toBeVisible();
	});

	// 🚨 **Bluesky is last, and this is a layout constraint the brand rule imposes rather than
	// a preference somebody can reorder past.** The butterfly keeps its own color in both the
	// selected and unselected state — dimming it would be tinting somebody else's trademark —
	// so it is the most saturated thing in the strip at all times. In the middle of three tabs
	// it becomes the visual center of a control whose center carries no meaning, and the eye
	// lands there rather than on the selected tab. A test rather than a comment alone, because
	// the order is one line and the reason for it is nowhere near that line.
	test("the butterfly sits at the end, where the strongest color does no harm", async ({
		page,
	}) => {
		await page.goto("/subscribe");
		const tabs = topSignup(page).getByRole("tab");
		await expect(tabs).toHaveCount(3);
		await expect(tabs.nth(2)).toHaveAccessibleName("Bluesky");
	});

	// ⚠️ **The address is not asked for here, and somebody pressing the button needs to know
	// one is coming.** This is the only place that says so before `/finish` says it — which
	// makes it the same kind of promise as the Bluesky panel's email-scope warning, pinned for
	// the same reason.
	test("it says an email address is coming next", async ({ page }) => {
		await page.goto("/subscribe");
		await openHandleDoor(page);
		// Filtered to the visible copy: the card sizes itself by stacking every note it can show
		// and hiding all but one, so this sentence is in the DOM at every reading of the page.
		await expect(
			topSignup(page)
				.getByText(/ask for your email next/i)
				.filter({ visible: true }),
		).toBeVisible();
		// And it does not ask for one here, which is what keeps the panel a single field.
		await expect(topSignup(page).getByLabel(/where should we reach you/i)).toHaveCount(0);
	});

	test("a name that is taken is refused before anybody commits to it", async ({ page }) => {
		await page.goto("/subscribe");
		await stubAvailability(page, (name) => ({
			status: "taken",
			handle: `${name}.anthers.social`,
		}));
		await openHandleDoor(page);

		await topSignup(page).getByLabel("The handle you'd like").fill("alice");
		await expect(topSignup(page).getByText(/alice\.anthers\.social is taken/i)).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /create my free account/i }),
			"a name the node has already given away is not one to send anybody to /finish with",
		).toBeDisabled();
	});

	// ⭐ **The available line names the whole handle rather than saying "available".** The
	// suffix is the part somebody has not thought about, and they are choosing a domain name
	// they will effectively control — saying it once, here, is cheaper than explaining it later.
	test("an available name is shown in full, suffix and all", async ({ page }) => {
		await page.goto("/subscribe");
		await stubAvailability(page, (name) => ({
			status: "available",
			handle: `${name}.anthers.social`,
		}));
		await openHandleDoor(page);

		await topSignup(page).getByLabel("The handle you'd like").fill("alice");
		await expect(topSignup(page).getByText(/alice\.anthers\.social is yours/i)).toBeVisible();
	});

	// 🚨 **An answer we could not get must not read as approval.** Silence under the field is
	// the one thing that would let somebody believe a name is theirs because a request failed.
	test("a check that could not be made says so, and still lets the signup through", async ({
		page,
	}) => {
		await page.goto("/subscribe");
		await stubAvailability(page, () => ({ status: "unknown", handle: "" }));
		await openHandleDoor(page);

		await topSignup(page).getByLabel("The handle you'd like").fill("alice");
		await expect(topSignup(page).getByText(/couldn't check that just now/i)).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /create my free account/i }),
			"the node is the authority, and a browser that could not ask has learned nothing",
		).toBeEnabled();
	});

	test("the name typed into the card is what the pending signup carries", async ({ page }) => {
		await page.goto("/subscribe");
		await stubAvailability(page, (name) => ({
			status: "available",
			handle: `${name}.anthers.social`,
		}));

		let payload: unknown = null;
		await page.route("**/api/auth/signup/begin", async (route) => {
			payload = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ success: true }),
			});
		});

		await openHandleDoor(page);
		// ⚠️ Typed WITH the leading `@`, because that is how people write a handle and it is not
		// part of one. Stripping it is a real behavior and this is the only test of it.
		await topSignup(page).getByLabel("The handle you'd like").fill("@alice");
		await topSignup(page)
			.getByRole("button", { name: /create my free account/i })
			.click();

		await expect.poll(() => payload).not.toBeNull();
		expect(payload).toMatchObject({ hostedHandle: "alice" });

		// 🚨 **The card hands off to `/finish` rather than finishing here.** A page that both
		// asks for a handle and completes a signup is the second door this spec exists to
		// prevent — and `/finish` is where the address, which nothing has asked for yet, is
		// taken.
		await expect(page).toHaveURL(/\/finish$/);
	});

	// ⭐ **The other half of the handoff, and the reason it is a separate test.** The one above
	// intercepts `/signup/begin` so it can read what was sent; this one lets it through so
	// there is a real pending signup to come back to, and asserts on what `/finish` then says.
	// Without this, "the name travels" is only checked as far as the request body.
	test("the finishing page names the handle, and says it is not yours yet", async ({ page }) => {
		await page.goto("/subscribe");
		await stubAvailability(page, (name) => ({
			status: "available",
			handle: `${name}.anthers.social`,
		}));
		await openHandleDoor(page);
		await topSignup(page).getByLabel("The handle you'd like").fill("someonenewentirely");
		await topSignup(page)
			.getByRole("button", { name: /create my free account/i })
			.click();

		await expect(page).toHaveURL(/\/finish$/);
		// ⚠️ **Matched as `name` followed by a suffix, not as `name.anthers.social`.** This
		// suite points the API at `node.invalid` (see `playwright.config.ts`), so the suffix
		// here is the test environment's rather than production's — and what is being asserted
		// is that the WHOLE handle is shown rather than the part somebody typed, which is the
		// property that survives either.
		await expect(page.getByText(/someonenewentirely\.[a-z.]+/)).toBeVisible();

		// 🚨 **Nothing is reserved by asking**, and the page has to say so. Two people may ask
		// for the same name and the second is told when the first confirms — a page that let
		// somebody believe the name was already theirs would be making a promise on behalf of
		// whoever confirms first.
		await expect(page.getByText(/issued once you confirm your email/i)).toBeVisible();

		// And it asks for the address, which is the whole reason the card did not.
		await expect(page.getByLabel(/where should we reach you/i)).toBeVisible();
	});
});
