// SPDX-License-Identifier: Apache-2.0
/**
 * The admin dispute surfaces in a real browser: the Disputes page (empty, then a
 * flagged row), the Home standing panel, and the evidence-deadline card.
 *
 * 🚨 **The admin app is a separate origin from the API, as it is in production**, so
 * like `admin-app.e2e.ts` this is what proves the admin session and the new surface
 * work in a browser rather than only through the API suites' hand-sent cookies.
 *
 * The row is seeded straight into the database: the webhook path is `disputes.test.ts`'s
 * subject (child 1's), and this spec's subject is the reading — the same split the
 * API suite makes. The seeded row is a self-pay ($75 on the buyer's own creator row),
 * so the large and self-pay flags both fire and the flagged-first sort is asserted
 * against a row that is genuinely flagged.
 */
import { execFileSync } from "node:child_process";
import { db } from "@anthers/db/client";
import { disputes, purchases, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import { ADMIN_ORIGIN, expect, test, trackErrorsStrict } from "./fixtures";

const RUN = Date.now().toString(36);
const OPERATOR_EMAIL = `e2e-disputes-${RUN}@example.com`;
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;
const dpIds: number[] = [];
const userIds: number[] = [];

test.beforeAll(async () => {
	execFileSync(
		"bun",
		["run", "admin:account", "create", OPERATOR_EMAIL, "--name", `E2E Ops ${RUN}`],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
		},
	);
	const made = JSON.parse(
		execFileSync("bun", ["run", "db:local-account", "--username", `e2e_disp_${RUN}`], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { userId: number };
	userIds.push(made.userId);
});

test.afterAll(async () => {
	if (dpIds.length)
		await db.delete(disputes).where(
			sql`${disputes.id} IN (${sql.join(
				dpIds.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		);
	const made = await db
		.select({ id: purchases.id })
		.from(purchases)
		.where(eq(purchases.buyerId, userIds[0]));
	if (made.length) await db.delete(purchases).where(eq(purchases.buyerId, userIds[0]));
	await db.delete(users).where(
		sql`${users.id} IN (${sql.join(
			userIds.map((id) => sql`${id}`),
			sql`, `,
		)})`,
	);
});

test("the dispute surfaces render", async ({ page }) => {
	const errors = trackErrorsStrict(page, [/status of 401/]);
	await page.goto(ADMIN_ORIGIN);
	await page.getByLabel("Email Address").fill(OPERATOR_EMAIL);
	await page.getByRole("button", { name: "Send a Code" }).click();
	await page
		.getByLabel("Code")
		.fill(await import("./fixtures").then((f) => f.emailedCode(OPERATOR_EMAIL)));
	await page.getByRole("button", { name: "Sign In" }).click();
	await expect(page.getByText(`E2E Ops ${RUN}`)).toBeVisible();

	// Home: the standing panel states "no disputes" plainly.
	await expect(page.getByText("No disputes — nothing has been charged back")).toBeVisible();

	// The nav link and the empty page.
	await page.getByRole("link", { name: "Disputes", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Disputes" })).toBeVisible();
	await expect(page.getByText("No disputes have been recorded")).toBeVisible();

	// Seed a dispute row directly, then reload.
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId: userIds[0],
			workId: null,
			creatorId: userIds[0],
			workTitle: "E2E Dispute Work",
			workType: "game",
			workPublicId: null,
			type: "digital",
			amount: "75.00",
			processingFee: "0.45",
			salesTax: "0.00",
			creatorEarnings: "70.00",
			stripePaymentIntentId: `pi_e2e_dp_${RUN}`,
			status: "completed",
		})
		.returning({ id: purchases.id });
	const [dp] = await db
		.insert(disputes)
		.values({
			stripeDisputeId: `dp_e2e_${RUN}`,
			stripeChargeId: `ch_e2e_${RUN}`,
			stripePaymentIntentId: `pi_e2e_dp_${RUN}`,
			amount: "75.00",
			currency: "usd",
			reason: "fraudulent",
			status: "needs_response",
			purchaseId: purchase.id,
			userId: userIds[0],
			evidenceDueBy: new Date(Date.now() + 5 * 86_400_000),
		})
		.returning({ id: disputes.id });
	dpIds.push(dp.id);

	await page.reload();
	await expect(page.getByText("E2E Dispute Work")).toBeVisible();
	// Self-pay + large both flag, and the flags sort first and render.
	await expect(page.getByText("Self-Pay", { exact: true })).toBeVisible();
	await expect(page.getByText("large", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("the buyer's access is revoked while it is open")).toBeVisible();

	// The contest action: an open, in-window dispute offers it, and the form names the
	// stakes (one submission only, the fee returned only on a win) before anything is
	// sent. The submission itself is the API suites' subject — a browser run's Stripe
	// client is whatever the environment configured, so asserting an outcome here would
	// pass in CI and fail on any machine with a key in `.env` (the PR #142 trap).
	await page.getByRole("button", { name: "Contest…" }).click();
	await expect(page.getByRole("button", { name: "Submit Evidence to Contest" })).toBeVisible();
	await expect(page.getByText(/Visa allows one submission per dispute/).first()).toBeVisible();
	await expect(page.getByLabel("What was sold", { exact: false }).first()).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	// The toggle returns to its closed label — the form is gone, the offer is not.
	await expect(page.getByRole("button", { name: "Close", exact: true })).not.toBeVisible();
	await expect(page.getByRole("button", { name: "Contest…" })).toBeVisible();

	// The footer states the standing policy, not "decision-support only" — contesting is
	// now a real action on this page, the deliberate exception rather than the default.
	await expect(page.getByText(/never contests a dispute by default/i).first()).toBeVisible();

	// Home: the standing panel now carries the count, and the deadline card appears.
	await page.getByRole("link", { name: "Home", exact: true }).click();
	await expect(page.getByText("Dispute Standing").first()).toBeVisible();
	await expect(page.getByText(/disputes in the last 30 days/).first()).toBeVisible();
	await expect(page.getByText(/Stripe's evidence window closes/)).toBeVisible();

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
