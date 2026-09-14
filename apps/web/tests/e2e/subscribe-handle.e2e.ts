// SPDX-License-Identifier: Apache-2.0
/**
 * The handle door on `/subscribe` — the one where Anthers issues the identity, and the one a
 * visitor now meets first.
 *
 * `/subscribe` is the single signup door and this spec's job, like its Bluesky sibling's, is
 * to keep it single. A new tab is exactly the change that grows a second way in by accident:
 * the 2026-08-17 consolidation deleted a Create Account card for that reason, and the two
 * doors it replaced had already drifted about terms and onboarding.
 *
 * 🚨 **Signing up starts with a handle rather than an address** (Parker, 2026-09-08), because
 * the records a *reader* writes belong in that reader's own repository — so an account with no
 * identity could never write a follow or a comment, which makes it permanently lesser rather
 * than merely plainer. There is no address door at all: with hosting unconfigured the card
 * offers Bluesky alone.
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

/**
 * Wait for the handle door, which is the one the card opens on.
 *
 * ⚠️ **Waiting is the whole of this now that it needs no click.** The card shows a placeholder
 * until `GET /api/atproto/config` says which doors exist, so asserting anything before that
 * answers is asserting about a shape rather than about a door.
 */
async function openHandleDoor(page: Page) {
	await expect(topSignup(page).getByRole("tab", { name: "Anthers", exact: true })).toBeVisible();
}

test.describe("signing up with a handle Anthers issues", () => {
	test("the handle is the door a visitor meets, and there is no address door", async ({ page }) => {
		await page.goto("/subscribe");
		await openHandleDoor(page);

		await expect(topSignup(page).getByLabel("The handle you'd like")).toBeVisible();

		// 🚨 **There is no address door.** Offering "just an address" would offer an account that
		// can never write a follow or a comment, and every account is an identity.
		await expect(
			topSignup(page).getByRole("tab", { name: "Email", exact: true }),
			"an address-only account is never on offer",
		).toHaveCount(0);
		await expect(topSignup(page).getByLabel(/where should we reach you/i)).toHaveCount(0);
		await expect(
			topSignup(page).getByRole("button", { name: /sign up with anthers/i }),
			"the button should refuse until there is a name to ask for",
		).toBeDisabled();

		// ⭐ **The suffix is in the field rather than in a sentence under it** (Parker,
		// 2026-09-08, following Bluesky's own signup). An empty field already reads as the
		// domain a handle hangs under, and a filled one reads the whole handle as it will
		// exist — which is a better place to meet that fact than an explanation nobody asked
		// for. Matched loosely because this suite's suffix is the test environment's.
		await expect(topSignup(page).getByText(/^\.[a-z.]+$/)).toBeVisible();
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
		await expect(tabs).toHaveCount(2);
		await expect(tabs.nth(1)).toHaveAccessibleName("Bluesky");
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
			topSignup(page).getByRole("button", { name: /sign up with anthers/i }),
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
			topSignup(page).getByRole("button", { name: /sign up with anthers/i }),
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
			.getByRole("button", { name: /sign up with anthers/i })
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
	test("the finishing page names the handle, and says it is held", async ({ page }) => {
		// ⚠️ Stubbed BEFORE the page loads. Registering a route afterwards leaves a window in
		// which the card's first check reaches the real API, which is a race that resolves
		// differently under parallel load than it does alone.
		await stubAvailability(page, (name) => ({
			status: "available",
			handle: `${name}.anthers.social`,
		}));
		await page.goto("/subscribe");
		await openHandleDoor(page);
		// ⚠️ **A fresh name every run, because asking reserves it.** A fixed name is held by the
		// previous run's pending signup for a week, and the second run would be refused.
		const name = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await topSignup(page).getByLabel("The handle you'd like").fill(name);
		await topSignup(page)
			.getByRole("button", { name: /sign up with anthers/i })
			.click();

		await expect(page).toHaveURL(/\/finish$/);

		// 🚨 **Wait for something only the loaded page draws, before asserting about its
		// content.** `toHaveURL` resolves the instant the client-side route changes, and this
		// page then awaits two real requests against a shared database before it renders
		// anything — so under parallel load the assertions below can run against a spinner.
		// This one is also the point: the address is asked for here, which is the whole reason
		// the card did not ask for it.
		await expect(page.getByLabel(/where should we reach you/i)).toBeVisible({ timeout: 15_000 });

		// ⚠️ **Matched as `name` followed by a suffix, not as `name.anthers.social`.** This
		// suite points the API at `node.invalid` (see `playwright.config.ts`), so the suffix
		// here is the test environment's rather than production's — and what is being asserted
		// is that the WHOLE handle is shown rather than the part somebody typed, which is the
		// property that survives either.
		await expect(page.getByText(new RegExp(`${name}\\.[a-z.]+`))).toBeVisible();

		// 🚨 **Pressing the button reserved the name**, and the page says so and until when, so
		// confirming tomorrow is safe.
		await expect(page.getByText(/is held for you until/i)).toBeVisible();
	});

	// 🚨 **With hosting unconfigured the Anthers door closes and Bluesky stands alone.** There is
	// no address door to fall back to, because an account is always an identity — and a door that
	// cannot work is worse than no door, so the Anthers tab is absent rather than refusing.
	test("with hosting unconfigured, Bluesky is the only door", async ({ page }) => {
		await page.route("**/api/atproto/config", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ hostedIdentityOffered: false, hostedHandleSuffix: "" }),
			});
		});
		await page.goto("/subscribe");

		await expect(topSignup(page).getByLabel("Bluesky handle")).toBeVisible();
		await expect(topSignup(page).getByRole("tab")).toHaveCount(0);
		await expect(topSignup(page).getByLabel(/where should we reach you/i)).toHaveCount(0);
		await expect(topSignup(page).getByLabel("The handle you'd like")).toHaveCount(0);
	});

	// 🚨 **A name held for somebody else's signup is refused on the card, in the field's own line.**
	// The reservation is what stops two people being promised one name, and the refusal has to
	// arrive while the person is still looking at the field — in the reserved line, so the card
	// does not grow under them.
	test("a name held for another signup is refused where it was typed", async ({ page }) => {
		await stubAvailability(page, (name) => ({
			status: "available",
			handle: `${name}.node.invalid`,
		}));
		await page.route("**/api/auth/signup/begin", async (route) => {
			await route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ error: "heldname.node.invalid is taken." }),
			});
		});
		await page.goto("/subscribe");
		await openHandleDoor(page);
		await topSignup(page).getByLabel("The handle you'd like").fill("heldname");
		await topSignup(page)
			.getByRole("button", { name: /sign up with anthers/i })
			.click();

		await expect(topSignup(page).getByText("heldname.node.invalid is taken.")).toBeVisible();
		await expect(page).toHaveURL(/\/subscribe/);
		await expect(
			topSignup(page).getByRole("button", { name: /sign up with anthers/i }),
		).toBeDisabled();
	});

	// 🚨 **Spelling is answered in the browser, without asking anything.** An underscore is
	// wrong in a way the card already knows, and round-tripping it would spend a debounce plus
	// latency to say something immediate — worse, it would read as *"we couldn't check"* rather
	// than *"that is not allowed"* whenever the API is unreachable. The route is failed rather
	// than stubbed here, because a stub that answered would hide exactly the behavior under
	// test: nothing may be asked at all.
	test("a name that cannot be a handle is refused without asking the server", async ({ page }) => {
		let asked = 0;
		await page.route("**/api/atproto/handle-available**", async (route) => {
			asked += 1;
			await route.abort();
		});
		await page.goto("/subscribe");
		await openHandleDoor(page);

		await topSignup(page).getByLabel("The handle you'd like").fill("bad_name");
		await expect(topSignup(page).getByText(/no underscores/i)).toBeVisible();
		await expect(
			topSignup(page).getByRole("button", { name: /sign up with anthers/i }),
		).toBeDisabled();

		// Long enough that a 400ms debounce would have fired several times over.
		await page.waitForTimeout(1500);
		expect(asked, "a name that cannot be a handle is not worth asking about").toBe(0);
	});
});
