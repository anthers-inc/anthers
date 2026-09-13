// SPDX-License-Identifier: Apache-2.0
/**
 * An operator places and lifts a legal hold in a real browser.
 *
 * 🚨 **The whole point of this surface is that it works at 2am**, in a browser, for one
 * person under time pressure — so the API tests are not enough on their own. A form that
 * posts the wrong field name, a button that never enables, or a table that drops the
 * lifted row all pass every assertion in `legal-hold-console.test.ts` and fail the only
 * job the feature has.
 *
 * ⚠️ **The operator is created here rather than reused from the gauntlet.** The gauntlet
 * viewer and creator are deliberately ordinary accounts, and promoting either of them to
 * `is_admin` inside a test would leave the flag set for every suite that follows.
 */
import { db } from "@anthers/db/client";
import { legalHolds, sessions, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import { expect, test, trackErrorsStrict, WEB_ORIGIN } from "./fixtures";

const RUN = Date.now().toString(36);
const OPERATOR = `e2e_op_${RUN}`;

let operatorId = 0;
/** The operator's session, written beside the account because there is no sign-up to issue one. */
const TOKEN = `e2e-op-${RUN}-${crypto.randomUUID()}`;

test.beforeAll(async () => {
	// Accounts are made by an emailed-code ceremony a browser test cannot read, so the operator
	// and a live session for it are written directly. Admin is set the same way it is set in
	// production, by a write nobody can reach through the app.
	const [row] = await db
		.insert(users)
		.values({ username: OPERATOR, email: `${OPERATOR}@example.com`, isAdmin: true })
		.returning({ id: users.id });
	operatorId = row.id;
	await db
		.insert(sessions)
		.values({ token: TOKEN, userId: operatorId, expiresAt: new Date(Date.now() + 3_600_000) });
});

test.afterAll(async () => {
	await db.delete(legalHolds).where(eq(legalHolds.subjectId, operatorId));
	await db.execute(sql`DELETE FROM users WHERE username = ${OPERATOR}`);
});

test("an operator can place a hold and lift it, and the lifted one stays on the page", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);

	await context.addCookies([
		{
			name: "session",
			value: TOKEN,
			domain: "localhost",
			path: "/",
			expires: Math.floor(Date.now() / 1000) + 3600,
			httpOnly: true,
			secure: false,
			sameSite: "Lax" as const,
		},
	]);

	await page.goto(`${WEB_ORIGIN}/admin`);

	// Scoped to the section rather than the page: "Refresh" and "Place hold" are
	// generic enough that a page-wide locator would happily test the wrong console.
	const holds = page.locator("section", { has: page.getByText("Legal holds") }).first();
	await expect(holds).toBeVisible();

	await holds.getByLabel("What kind").selectOption("user");
	await holds.getByLabel("Its id").fill(String(operatorId));
	await holds.getByLabel(/^Why/).fill(`E2E preservation, run ${RUN}`);
	await holds.getByRole("button", { name: "Place hold" }).click();

	// The label, not a tick. It is what tells an operator they held the account they
	// meant rather than the one they typed.
	await expect(page.getByText(`Held @${OPERATOR}.`)).toBeVisible();

	const row = holds.locator("tr", { hasText: `E2E preservation, run ${RUN}` }).first();
	await expect(row).toBeVisible();
	await expect(row.getByText("active")).toBeVisible();

	// The section rather than the page: a full-page shot of this app is mostly the fixed
	// site header sitting on top of whatever it was meant to show.
	await holds.screenshot({ path: `.screenshots/admin-legal-holds-${RUN}.png` });

	// Two clicks on purpose: lifting ends a preservation, and a single misplaced click
	// should not be able to do that.
	await row.getByRole("button", { name: "Lift", exact: true }).click();
	await row.getByRole("button", { name: "Confirm lift" }).click();

	const lifted = holds.locator("tr", { hasText: `E2E preservation, run ${RUN}` }).first();
	await expect(lifted, "a lifted hold must stay on the page").toBeVisible();
	await expect(lifted.getByText("lifted")).toBeVisible();

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
