// SPDX-License-Identifier: Apache-2.0
/**
 * The sidebar nav's own contract — the Library / Network / Discovery rows and the drag
 * handles beside them.
 *
 * 🚨 **Two of these assertions exist because a regression shipped through them.** #437
 * introduced the grips and a wrapper row, and in doing so interpolated the NavLink's
 * className *function* into a template string — the function's source landed in the
 * class attribute as a string, no styles applied, and the items rendered as unstyled
 * stacks of icon-over-label. The same PR gave the grip its drag handlers but no
 * `draggable` attribute, so a grip drag started a text selection instead of an HTML5
 * drag. The scratch spec that was "verifying" #437's drag proved only that a request
 * could fire; nothing pinned the row's shape or the reorder, so both broke silently.
 *
 * ⚠️ **The drag here REARRANGES the gauntlet walker's sidebar, and the walker is the
 * account every spec in this project shares.** The last test puts the default order
 * back the moment it finishes asserting — the only surface affected in the window is
 * `/` (RootRedirect), which no other authed spec reads except video-player's
 * goto("/"), and that one navigates on to a `/works/…` slug regardless of where the
 * redirect lands it.
 */
import { expect, test } from "@playwright/test";
import { API_URL, WEB_ORIGIN } from "./fixtures";

const ROWS = "nav[aria-label='Anthers'] > div > a";

/** The three nav labels, in the order they render. */
const labels = (page: import("@playwright/test").Page) =>
	page.evaluate(
		(sel: string) => [...document.querySelectorAll(sel)].map((a) => a.textContent?.trim()),
		ROWS,
	);

test.describe.configure({ mode: "serial" });

test("the nav items read as rows — icon beside label at the nav's small size", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/network`);
	const nav = page.getByRole("navigation", { name: "Anthers" });
	const link = nav.getByRole("link", { name: "Network" });
	await expect(link).toBeVisible();
	expect(await labels(page)).toEqual(["Library", "Network", "Discovery"]);

	// The item carries its real classes (the regression shipped a function's source
	// as the className — nothing applied, and the row collapsed into stacked text).
	const cls = await link.getAttribute("class");
	expect(cls).toContain("text-sm");
	expect(cls).toContain("flex");

	// The icon sits beside the label, not above it, at the nav's 14px — the broken
	// sidebar had the icon above a full-size label.
	const icon = await link.locator("svg").boundingBox();
	const label = await link.evaluate((el) => {
		const node = [...el.childNodes].find(
			(n) => n.nodeType === Node.TEXT_NODE && (n.textContent?.trim().length ?? 0) > 0,
		);
		if (!node) return null;
		const range = document.createRange();
		range.selectNode(node);
		const rect = range.getBoundingClientRect();
		return { x: rect.x, y: rect.y };
	});
	expect(icon, "the item's icon renders").not.toBeNull();
	expect(label, "the item's label text renders").not.toBeNull();
	expect(await link.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
	expect(
		icon && label && label.y < icon.y + icon.height,
		"the label sits beside the icon, not under it",
	).toBe(true);
	expect(icon && label && label.x > icon.x, "the label is to the icon's right").toBe(true);

	// Each row carries its grip at the right edge, inside the sidebar's own width —
	// a grip clipped by the aside would look draggable and then do nothing. The aside
	// opens on a 200ms width transition; the inner column lays out at full `w-64`
	// throughout, so measure only after the box has finished.
	const navEl = page.locator("nav[aria-label='Anthers']");
	await expect
		.poll(
			() =>
				navEl.evaluate((el) =>
					Math.round((el.closest("aside") as HTMLElement).getBoundingClientRect().width),
				),
			{ timeout: 2_000 },
		)
		.toBe(256);
	const asideBox = await navEl.evaluate((el) =>
		(el.closest("aside") as HTMLElement).getBoundingClientRect(),
	);
	for (const name of ["Library", "Network", "Discovery"]) {
		const grip = nav
			.getByRole("link", { name })
			.locator("..")
			.locator("span[title='Drag to reorder']");
		await expect(grip).toBeVisible();
		const gripBox = await grip.boundingBox();
		expect(gripBox, `the ${name} row's grip renders`).not.toBeNull();
		if (gripBox) {
			expect(
				gripBox.x + gripBox.width,
				"the grip is not clipped by the sidebar",
			).toBeLessThanOrEqual(asideBox.x + asideBox.width);
		}
	}
});

test("a grip's drag reorders, persists, and the order survives a fresh boot", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/network`);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Network" }),
	).toBeVisible();
	expect(await labels(page)).toEqual(["Library", "Network", "Discovery"]);

	// A real HTML5 drag, dispatched in the page (DataTransfer exists only there):
	// dragstart on the second row's grip, drop on the first row. The drop's PATCH can
	// complete before the evaluate returns, so the wait is registered first, and on
	// the RESPONSE — the write, not the send.
	const patch = page.waitForResponse(
		(r) => r.url().includes("/api/accounts/me") && r.request().method() === "PATCH",
		{ timeout: 10_000 },
	);
	const dispatch = await page.evaluate(() => {
		const rows = [...document.querySelectorAll("nav[aria-label='Anthers'] > div")];
		const grip = rows[1]?.querySelector("span[title='Drag to reorder']");
		if (!grip) return { error: `no grip among ${rows.length}` };
		grip.dispatchEvent(
			new DragEvent("dragstart", {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer(),
			}),
		);
		rows[0]?.dispatchEvent(
			new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				dataTransfer: new DataTransfer(),
			}),
		);
		rows[0]?.dispatchEvent(
			new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }),
		);
		return { selection: window.getSelection()?.toString() ?? "" };
	});
	expect(dispatch, "the grip starts a drag (no grip, no drag)").not.toHaveProperty("error");
	expect(dispatch.selection, "an item drag never text-selects").toBe("");
	const reorder = await patch;
	expect(reorder.status(), "the reorder persists").toBe(200);
	expect(
		(await reorder.request().postDataJSON())?.homeNavOrder,
		"the write carries the drop's whole order",
	).toEqual(["network", "library", "discovery"]);

	// Local-first: the drop reorders the sidebar immediately, no boot needed.
	await expect
		.poll(() => labels(page), { timeout: 5_000 })
		.toEqual(["Network", "Library", "Discovery"]);

	// The reloaded shell boots from the account's saved order — and `/`, the one
	// route every visit lands on, goes to the top of it.
	await page.reload();
	await expect
		.poll(() => labels(page), { timeout: 5_000 })
		.toEqual(["Network", "Library", "Discovery"]);
	await page.goto(`${WEB_ORIGIN}/`);
	await expect(page).toHaveURL(/\/network$/);

	// The walker is the shared account: put the default order back before anything
	// else reads it (belt-and-braces afterAll below catches a mid-test failure).
	await page.request.patch(`${API_URL}/api/accounts/me`, {
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		data: { homeNavOrder: ["library", "network", "discovery"] },
	});
});

test.afterAll(async ({ browser }) => {
	// The restore above runs only if the drag test reaches its end; this is the same
	// patch on the failure path. The context carries the walker's own session cookie
	// (the storage state the setup project writes) so the write authenticates.
	const context = await browser.newContext({
		storageState: "tests/e2e/.auth/gauntlet-walker.json",
	});
	const res = await context.request
		.patch(`${API_URL}/api/accounts/me`, {
			headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
			data: { homeNavOrder: ["library", "network", "discovery"] },
			failOnStatusCode: false,
		})
		.catch(() => null);
	if (!res || (res && res.status() !== 200)) {
		console.warn("the nav-order restore did not land — a next run's fixture reset is the backstop");
	}
	await context.close();
});
