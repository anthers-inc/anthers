// SPDX-License-Identifier: Apache-2.0
/**
 * An operator signs in to the admin app with an emailed code, then places and lifts a legal hold.
 *
 * 🚨 **The admin app is a separate origin from the API, as it is in production**, so this is what
 * proves the admin session works in a real browser: a `__Host-` cookie with `SameSite=Strict`, set
 * by the API and sent back on the app's requests. Every API test sends the cookie by hand and would
 * pass against a cookie no browser keeps.
 *
 * 🚨 **The legal-hold half is here because that surface has to work at 2am**, for one person under
 * time pressure. A form posting the wrong field, a button that never enables, or a table that drops
 * the lifted row all pass `legal-hold-console.test.ts` and fail the only job the feature has.
 *
 * The admin account is made with `admin:account`, the script that makes the first one in production,
 * and signed into through the mail catcher, which is where a person would read the code.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "@anthers/db/client";
import {
	adminAccountEvents,
	adminAccounts,
	adminSessions,
	legalHolds,
	users,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { ADMIN_ORIGIN, emailedCode, expect, test, trackErrorsStrict } from "./fixtures";

const RUN = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-operator-${RUN}@example.com`;
const SUBJECT = `e2e_held_${RUN}`;

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

let subjectId = 0;

test.beforeAll(async () => {
	execFileSync(
		"bun",
		["run", "admin:account", "create", OPERATOR_EMAIL, "--name", `E2E Operator ${RUN}`],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
		},
	);
	// Something to hold: an ordinary account, made the way every seed makes one.
	const made = JSON.parse(
		execFileSync("bun", ["run", "db:local-account", "--username", SUBJECT], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { userId: number };
	subjectId = made.userId;
});

test.afterAll(async () => {
	await db.delete(legalHolds).where(eq(legalHolds.subjectId, subjectId));
	await db.delete(users).where(eq(users.username, SUBJECT));
	const operators = await db
		.select({ id: adminAccounts.id })
		.from(adminAccounts)
		.where(eq(adminAccounts.email, OPERATOR_EMAIL));
	const ids = operators.map((o) => o.id);
	if (ids.length > 0) {
		await db.delete(adminAccountEvents).where(inArray(adminAccountEvents.accountId, ids));
		await db.delete(adminSessions).where(inArray(adminSessions.accountId, ids));
		await db.delete(adminAccounts).where(inArray(adminAccounts.id, ids));
	}
});

test("an operator signs in by emailed code, places a hold and lifts it", async ({ page }) => {
	// A signed-out load asks who is signed in and is told nobody (401), which Chromium logs as an
	// error. That one answer is expected; anything else is not.
	const errors = trackErrorsStrict(page, [/status of 401/]);

	await page.goto(ADMIN_ORIGIN);
	await page.getByLabel("Email Address").fill(OPERATOR_EMAIL);
	await page.getByRole("button", { name: "Send a Code" }).click();
	await expect(page.getByLabel("Code")).toBeVisible();
	await page.getByLabel("Code").fill(await emailedCode(OPERATOR_EMAIL));
	await page.getByRole("button", { name: "Sign In" }).click();

	// Signed in: the frame shows who, and a reload keeps them there, which only a kept cookie does.
	await expect(page.getByText(`E2E Operator ${RUN}`)).toBeVisible();
	await page.reload();
	await expect(page.getByText(`E2E Operator ${RUN}`)).toBeVisible();

	await page.getByRole("link", { name: "Legal Holds" }).click();
	const holds = page
		.locator("section", { has: page.getByRole("heading", { name: "Legal Holds" }) })
		.first();
	await expect(holds).toBeVisible();

	await holds.getByLabel("What Kind").selectOption("user");
	await holds.getByLabel("Its ID").fill(String(subjectId));
	await holds.getByLabel(/^Why/).fill(`E2E preservation, run ${RUN}`);
	await holds.getByRole("button", { name: "Place Hold" }).click();

	// The label, not a tick: it is what tells an operator they held the account they meant.
	await expect(page.getByText(`Held @${SUBJECT}.`)).toBeVisible();

	const row = holds.locator("tr", { hasText: `E2E preservation, run ${RUN}` }).first();
	await expect(row).toBeVisible();
	await expect(row.getByText("active")).toBeVisible();
	await expect(
		row.getByText(`E2E Operator ${RUN}`),
		"the hold names the admin account that placed it",
	).toBeVisible();

	await holds.screenshot({ path: `.screenshots/admin-legal-holds-${RUN}.png` });

	// Two clicks on purpose: lifting ends a preservation.
	await row.getByRole("button", { name: "Lift", exact: true }).click();
	await row.getByRole("button", { name: "Confirm Lift" }).click();

	const lifted = holds.locator("tr", { hasText: `E2E preservation, run ${RUN}` }).first();
	await expect(lifted, "a lifted hold must stay on the page").toBeVisible();
	await expect(lifted.getByText("lifted")).toBeVisible();

	await page.getByRole("button", { name: "Sign Out" }).click();
	await expect(page.getByRole("button", { name: "Send a Code" })).toBeVisible();

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
