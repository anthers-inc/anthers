// SPDX-License-Identifier: Apache-2.0
/**
 * The Issue Reports page: filing a report works in a real browser, signed out.
 *
 * 🚨 **The signed-out walk is the spec, not a convenience.** The person who hits the
 * site's worst bug is often signed out by the thing that is broken, so a session must
 * never be a prerequisite for filing — which is the same property `abuse-reports.test.ts`
 * pins at the API level, proven here at the browser level where a real session lifecycle
 * exists to refuse it.
 *
 * The admin end of the flow — reading the queue, marking ingested — is asserted in
 * `issue-reports.test.ts` at the API level; this file covers the half only a browser can
 * prove: the form fills, submits, and shows the reporter a reference number.
 */
import { db } from "@anthers/db/client";
import { issueReports } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { expect, test, WEB_ORIGIN } from "./fixtures";

const PAGE = `${WEB_ORIGIN}/issues`;

/** Every row this spec writes is taken back, on success or failure, like any fixture. */
const WRITTEN: string[] = [];

test.afterAll(async () => {
	for (const summary of WRITTEN) {
		await db.delete(issueReports).where(eq(issueReports.summary, summary));
	}
});

test.describe("issue reports", () => {
	test("the page renders in the public shell, linked from both footers", async ({ page }) => {
		await page.goto(PAGE);
		await expect(page.locator("h1").first()).toContainText("Report an Issue");
		// Pointing at /abuse rather than absorbing it — the two intakes are different
		// processes, and this page's job is handing a content report across in one sentence.
		await expect(page.getByRole("link", { name: "Report Abuse" })).toBeVisible();

		// The footer link, from the logged-out shell this page renders under.
		await page.goto(`${WEB_ORIGIN}/`);
		await expect(page.locator("footer a[href='/issues']")).toHaveText("Report an Issue");
	});

	test("a signed-out visitor files a report and gets a reference number", async ({ page }) => {
		await page.goto(PAGE);
		const summary = "Browser e2e fixture: form walk";
		WRITTEN.push(summary);
		await page.getByPlaceholder("Upload button spins forever").fill(summary);
		await page
			.locator("textarea")
			.fill(
				"An automated browser test filing a fixture report, to prove the signed-out walk works.",
			);
		// Optional fields stay empty: a location-less, anonymous report is ordinary,
		// not an edge case, and the walk must accept exactly that shape.
		await page.getByRole("button", { name: "Send Report" }).click();
		await expect(page.locator(".alert-success")).toContainText(/reference #\d+/);
	});

	test("the row the browser wrote is what the schema says it is", async ({ page }) => {
		const marker = `browser e2e fixture: ${Date.now().toString(36)}`;
		WRITTEN.push(marker);
		await page.goto(PAGE);
		await page.getByPlaceholder("Upload button spins forever").fill(marker);
		await page.locator("textarea").fill("Fixture report whose row this spec verifies directly.");
		await page.locator("input[type='email']").fill("browser-e2e@example.com");
		await page.getByRole("button", { name: "Send Report" }).click();
		await expect(page.locator(".alert-success")).toContainText(/reference #\d+/);

		// The row, verified against the session's own database — what the browser sent
		// reached the table with the reporter's email intact and nothing recorded about
		// who they were, because the walk carried no session.
		const row = await db
			.select()
			.from(issueReports)
			.where(eq(issueReports.summary, marker))
			.limit(1)
			.then((rows) => rows[0]);
		expect(row).toBeDefined();
		expect(row.details).toContain("verifies directly");
		expect(row.reporterEmail).toBe("browser-e2e@example.com");
		expect(row.reporterId).toBeNull();
		expect(row.status).toBe("open");
	});
});
