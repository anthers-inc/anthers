// SPDX-License-Identifier: Apache-2.0
/**
 * The Dashboard's Schedule panel, walked in a browser.
 *
 * What this proves is the join a unit test cannot reach: the panel exists as a storeable,
 * renderable Dashboard panel and lists both kinds a schedule holds — a Work's release and a
 * post's auto-publish — read from the two listings the page already fetches. The merge, sort
 * and waiting test are `studio-schedule.test.ts`'s; no worker runs in a browser session, so
 * a Work whose scheduled time passes here stays private, which is how the walk observes the
 * "as soon as it's ready" wording the Works row also carries.
 *
 * Runs on `media_fixture`, which nothing else resets and which has payouts set up, since
 * scheduling is refused for a creator who could not publish. Serial, and its own title
 * prefixes, like every fixture-walking spec.
 */
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import {
	API_URL,
	CREATED_CREDIT,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE_PREFIX = "Schedule panel ";
const POST_PREFIX = "Schedule panel post ";
/** What `DEFAULT_STUDIO_PANELS` is today; the walk's layout is restored to it afterwards. */
const ORDINARY_LAYOUT = ["processing", "earnings", "catalog"];

let session = "";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
	scheduledReleaseAt: string | null;
}

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

async function patch(url: string, json: unknown): Promise<Response> {
	return fetch(`${API_URL}${url}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify(json),
	});
}

async function sweep(): Promise<void> {
	if (!session) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
	const res = await fetch(`${API_URL}/api/content/posts?mine=true`, {
		headers: { Cookie: `session=${session}` },
	});
	const mine = (await res.json()) as {
		posts: Array<{ slug: string; title: string | null; isPublished: boolean | null }>;
	};
	for (const p of mine.posts.filter((p) => p.title?.startsWith(POST_PREFIX))) {
		await fetch(`${API_URL}/api/content/posts/${p.slug}`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
	// The fixture's layout matters to every other spec walking a dashboard: leaving the
	// schedule panel on would change what they render. Stored defaults are the same
	// resolution stored null gives, so this restores the ordinary layout.
	if (session) await patch(`/api/accounts/me/studio-panels`, { panels: ORDINARY_LAYOUT });
	await sweep();
});

test("a schedule of a release and a post shows on the Dashboard", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	await sweep();
	await patch(`/api/accounts/me/studio-panels`, { panels: ["schedule"] });

	// The soonest item goes out in a moment. A browser session runs no worker, so by the
	// time the Dashboard is read the time has passed with the Work still private — the
	// waiting case. The other two are a settled future, one per kind.
	const make = async (title: string, minutes: number): Promise<OwnedWork> => {
		const created = await fetch(`${API_URL}/api/content/works`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${session}`,
				Origin: WEB_ORIGIN,
			},
			body: JSON.stringify({
				type: "service",
				title,
				maturityRows: rowsRatedAs("general"),
				// Scheduling and the final release both ask for a human in the credits
				// (`credits_creator_required`); the schedule below would be refused without it.
				credits: CREATED_CREDIT,
			}),
		});
		const { work } = (await created.json()) as { work: OwnedWork };
		await patch(`/api/content/works/${work.id}`, {
			scheduledReleaseAt: new Date(Date.now() + minutes * 60_000).toISOString(),
		});
		return work;
	};
	const waiting = await make(`${TITLE_PREFIX}Waiting`, 0.03);
	await make(`${TITLE_PREFIX}Later`, 2 * 24 * 60);

	const post = await fetch(`${API_URL}/api/content/posts`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			title: `${POST_PREFIX}tomorrow`,
			body: "Announcing nothing in particular.",
			scheduledFor: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
		}),
	});
	// Created, with the schedule — a 201 like any other POST.
	expect(post.status).toBe(201);

	// Let the waiting Work's instants pass before the first look: the panel reads the clock
	// when it renders, not on a timer, so a page loaded too early would show the date a
	// reload can no longer show.
	await page.waitForTimeout(2000);
	await page.goto("/studio");
	await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();

	const panel = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Schedule" }) });
	const rows = panel.locator("ul > li");
	await expect(rows).toHaveCount(3);

	// Soonest first: the passed time reads as waiting — expect() retries until the browser's
	// clock crosses the instant, which is why the near-zero lead works at all — and the two
	// futures carry dates. Digits, not a spelling: the panel formats in the visitor's locale.
	const waitingRow = rows.filter({ hasText: "Waiting" });
	await expect(waitingRow).toContainText("As soon as it's ready");
	const postRow = rows.filter({ hasText: `${POST_PREFIX}tomorrow` });
	await expect(postRow).toContainText(/\d/);
	const laterRow = rows.filter({ hasText: "Later" });
	await expect(laterRow).toContainText("Release");
	await expect(laterRow).toContainText(/\d/);

	// Soonest first is list order: the waiting Work, then the post, then the later release.
	await expect(rows.nth(0)).toContainText("Waiting");
	await expect(rows.nth(1)).toContainText(`${POST_PREFIX}tomorrow`);
	await expect(rows.nth(2)).toContainText("Later");

	// The row points at the editor where the schedule is set, as the panel's job.
	await waitingRow.getByRole("link").click();
	await expect(page).toHaveURL(new RegExp(`/studio/works/${waiting.publicId}/edit`));

	// Clearing the schedule takes the row off: the panel re-reads on the next visit.
	await patch(`/api/content/works/${waiting.id}`, { scheduledReleaseAt: null });
	await page.goto("/studio");
	await expect(rows).toHaveCount(2);
	await expect(panel).not.toContainText("Waiting");
});
