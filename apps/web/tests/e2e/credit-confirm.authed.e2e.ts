// SPDX-License-Identifier: Apache-2.0
/**
 * A credit naming a real identity, walked from both sides of it.
 *
 * 🚨 **What only a browser can prove here is the FLAG, not the route.** The API suites prove the
 * accept and reject routes and the overlay's withholding; nothing there can see whether the
 * Work page renders Accept/Decline only for the person the credit names, whether the Studio
 * marks the row as waiting, or whether a stranger's page shows no controls and no credit at
 * all. The flag is the whole gate — the UI is forbidden from deciding identity for itself —
 * so these walks assert what each viewer's serialization actually rendered.
 *
 * Runs on `media_fixture` as the creator (whose Works nothing else resets, and whose payout
 * setup is seeded — see `work-release.authed.e2e.ts` for why any other owner cannot release)
 * and on the `authed` project's own signed-in viewer, `gauntlet_viewer`, as the credited
 * person. The viewer's DID comes off their public profile rather than out of the database:
 * the credit is written the way a creator would write it, by pasting the address of a real
 * account, and the walk then proves that account's own page renders the ask.
 *
 * Serial, and swept by title prefix, for the same reasons `work-release.authed.e2e.ts` gives:
 * a shared fixture must come back to empty even when a walk fails halfway.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAUNTLET_VIEWER_USERNAME, gauntletHandle } from "@anthers/db/gauntlet";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TITLE_PREFIX = "Credit walk ";
const TITLE = `${TITLE_PREFIX}${Date.now()}`;
const ROLE = "Written by";
/** The viewer's seeded display name, which an accepted credit resolves the DID to. */
const VIEWER_NAME = "Gauntlet Viewer";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
}

interface PublicProfile {
	user?: { atprotoDid?: string; handle?: string };
}

let session = "";
/** The viewer's DID, read from their public profile before the Work is created. */
let viewerDid = "";
/** The viewer's handle, for the sweep and for reading their notifications. */
let viewerHandle = "";

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

/**
 * Run the Work's listing sync the way the job would, for the one Work this walk releases.
 *
 * 🚨 **No worker runs in a browser session** — `work-schedule.authed.e2e.ts` documents the
 * same gap — so the sync the release enqueues never drains, the Work's listing never
 * appears, and the accept route refuses everything with `no_listing` forever. This calls
 * `syncWorkListing` directly, the same service call `seed-media-fixture.ts` makes to put
 * the fixture's catalog on the session's network: through the real code path, deciding for
 * itself what to write, rather than a row edited into claiming a listing it does not have.
 */
async function syncListing(workId: number): Promise<void> {
	// The same service call `seed-media-fixture.ts` makes to put the fixture's catalog on
	// the session's network. Run in a child process — importing the API's service from a
	// web spec would couple the suites — through `execFileSync("bun", …)`, the pattern
	// every other spec in this directory uses for its child commands.
	//
	// 🚨 Never `Bun.spawn` here: the Playwright worker runs under Node in CI, where the
	// Bun global does not exist and the spec dies on `ReferenceError: Bun is not defined`
	// before the walk starts — the runtime split between a local `bunx playwright test`
	// and CI's Playwright-under-Node is exactly the trap.
	//
	// The result travels through a file the script writes, so nothing depends on the
	// child's stdio draining — the service chain holds open handles (the database pool
	// among them), which is also why the script exits explicitly: the same reason the
	// seed scripts do.
	//
	// The scratch dir is `os.tmpdir()` + `mkdtempSync`, the same pattern
	// `work-upload.authed.e2e.ts` uses — never a hand-named `/tmp` path, which exists on
	// the machine it was written on and nowhere CI runs.
	const dir = mkdtempSync(join(tmpdir(), "anthers-credit-walk-"));
	const outFile = join(dir, `sync-${workId}.json`);
	const script = `const { syncWorkListing } = await import(${JSON.stringify(
		`${REPO_ROOT}/apps/api/src/services/work-listing.js`,
	)});
const result = await syncWorkListing(${workId});
const { writeFileSync } = await import("node:fs");
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(result));
console.log("synced");
process.exit(0);
`;
	const file = join(dir, `sync-${workId}.ts`);
	writeFileSync(file, script);
	try {
		execFileSync("bun", [file], { cwd: REPO_ROOT, stdio: "ignore" });
		const result = JSON.parse(readFileSync(outFile, "utf8")) as { status?: string };
		expect(result.status, `the released Work's listing sync did not run: ${outFile}`).toBe(
			"synced",
		);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

/** Delete every Credit-walk Work on the shared creator, so a failed run leaves no litter. */
async function sweep(): Promise<void> {
	if (!session) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.describe.configure({ mode: "serial" });

test.afterAll(sweep);

test("a creator credits a person by DID, the person confirms, and the credit resolves", async ({
	page,
	context,
	browser,
}) => {
	// Two sign-ins, two browser contexts and a listing sync on the session's network —
	// comfortably past Playwright's 30s default, as the gauntlet's own budget notes.
	test.setTimeout(120_000);
	session = await signInAsMediaFixture(context);
	viewerHandle = await gauntletHandle(API_URL, GAUNTLET_VIEWER_USERNAME);
	const profile = (await (
		await fetch(`${API_URL}/api/accounts/users/${viewerHandle}`)
	).json()) as PublicProfile;
	expect(profile.user?.atprotoDid, "the gauntlet viewer has no DID to credit").toBeTruthy();
	viewerDid = profile.user?.atprotoDid as string;
	// Sweep a crashed prior run's Work before creating this run's own.
	await sweep();

	// ── The creator writes the credit ────────────────────────────────────────────
	// Through the Studio's own editor, because the walk's subject includes that the
	// contributor field round-trips a raw DID verbatim — the acceptance keys on it.
	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "service", title: TITLE }),
	});
	expect(created.status).toBe(201);
	const { work } = (await created.json()) as { work: OwnedWork };
	const editUrl = `/studio/works/${work.publicId}/edit`;

	await page.goto(editUrl);
	// A `service` Work needs no file, so the only release gates are the rating and a
	// credit naming a human — both of which this walk is setting up anyway.
	await page.getByRole("button", { name: 'Mark the Rest "Not in It"' }).click();
	await page.getByRole("button", { name: "Add a credit" }).click();
	await page.getByRole("textbox", { name: "Credit 1 role" }).fill(ROLE);
	await page.getByRole("checkbox", { name: "Credit 1 Created" }).check();
	// The contributor field is free text; a `did:` string is just text, which is exactly
	// how a creator pastes the address of a real account.
	await page.getByRole("textbox", { name: "Credit 1 contributor" }).fill(viewerDid);

	// The Studio does NOT yet know whether the person has confirmed — the credit is new —
	// but the marker appears the moment the save returns the owner overlay's flag.
	await expect(page.getByText(/waiting on the contributor/i)).toHaveCount(0);

	await page.getByRole("checkbox", { name: /released to my public catalog/i }).check();
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
		timeout: 15_000,
	});

	// The release made the credit public, which is the moment the viewer is owed the ask.
	// The listing sync is run by hand here — no worker runs in a browser session (see
	// `syncListing` above) — so the record exists before the credited person's page is
	// asked to accept against it.
	await syncListing(work.id);

	// The marker reads the OWNER overlay, which arrives on the LOAD and on a save response —
	// but the editor's rows are local draft state that a save does not rebuild, so the
	// marker is asserted after a reload brings the server's own answer in. The flag
	// survived the draft mapping and the save sent only role, contributor and types, so
	// the row comes back flagged with its DID intact.
	await page.reload();
	await expect(page.getByText(/waiting on the contributor/i)).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Credit 1 contributor" })).toHaveValue(viewerDid);

	// The payload assertion, made while the FLAGGED row sits in draft state: an unrelated
	// edit's save must send only role, contributor and types. The overlay flags are
	// display state the server re-derives on load, and a flag leaking into a save would be
	// the editor asserting the contributor's confirmation for them.
	let savedCredits: unknown = null;
	const onRequest = (req: import("@playwright/test").Request) => {
		if (req.method() !== "PATCH" || !req.url().includes("/api/content/works/")) return;
		const body = req.postDataJSON() as { credits?: unknown };
		if (body?.credits !== undefined) savedCredits = body.credits;
	};
	page.on("request", onRequest);
	await page.getByRole("textbox", { name: "Credit 1 role" }).fill(`${ROLE} more`);
	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
		timeout: 15_000,
	});
	page.removeListener("request", onRequest);
	expect(savedCredits, "the editor's save never sent its credits table").toBeTruthy();
	expect(Array.isArray(savedCredits)).toBe(true);
	for (const credit of savedCredits as Record<string, unknown>[]) {
		expect(
			Object.keys(credit).sort(),
			"the save payload carries an overlay flag or a foreign key",
		).toEqual(["contributor", "role", "types"]);
	}

	// The credit-offered notification landed, and it links to the Work's page — that is
	// the "notify-landing" half: the inbox UI is a roadmap item, so the row and its
	// linkPath are what exists to walk.
	const [stored] = (await ownWorks()).filter((w) => w.title === TITLE);
	expect(stored, "the released Work is missing from the creator's own catalog").toBeTruthy();

	// ── The credited person confirms ──────────────────────────────────────────────
	// A second browser context signed in as the viewer — the authed project's own page
	// belongs to them already, but a fresh context keeps the two sessions from bleeding
	// into each other across the walk.
	const viewerContext = await browser.newContext({
		storageState: "tests/e2e/.auth/gauntlet-viewer.json",
	});
	const viewerPage = await viewerContext.newPage();
	await viewerPage.goto(`/works/${work.publicId}`);

	// The confirm ask renders, with the credit's own role — and the DID is what the
	// viewer sees, not their resolved name, because they have not confirmed yet.
	const ask = viewerPage.getByText("You're credited — confirm?");
	await expect(ask).toBeVisible();
	await expect(viewerPage.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
	await expect(viewerPage.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
	await expect(viewerPage.locator("section").filter({ hasText: "Credits" })).toContainText(
		viewerDid,
	);

	// The notification is in their list, pointing at this page.
	const notificationsRes = await fetch(`${API_URL}/api/accounts/me/notifications`, {
		headers: { Cookie: await viewerSessionCookie(viewerContext) },
	});
	expect(
		notificationsRes.ok,
		`reading the viewer's notifications failed: ${notificationsRes.status}`,
	).toBe(true);
	const notifications = (await notificationsRes.json()) as {
		notifications: { title?: string; linkPath?: string }[];
	};
	const offered = notifications.notifications.find((n) => n.title?.includes("credited"));
	expect(offered, "no credit-offered notification for the viewer").toBeTruthy();
	expect(offered?.linkPath).toContain(String(work.publicId));

	// Accept, and the credit settles from the server's own answer: the DID is gone and
	// the viewer's name is in its place, with no confirm ask left on the page.
	await viewerPage.getByRole("button", { name: "Accept", exact: true }).click();
	await expect(
		viewerPage.locator("section").filter({ hasText: "Credits" }),
		"the accepted credit did not resolve to the viewer's name",
	).toContainText(VIEWER_NAME, { timeout: 15_000 });
	await expect(viewerPage.getByText("You're credited — confirm?")).toHaveCount(0);
	await expect(
		viewerPage.getByRole("button", { name: "Accept", exact: true }),
		"the confirm controls survived their own acceptance",
	).toHaveCount(0);

	// ── The Studio's marker clears ───────────────────────────────────────────────
	// Back on the creator's page — a reload, since the acceptance happened elsewhere.
	// The role edit above means the marker-clear read also proves the DID survived a save
	// made with the flagged row in draft state.
	await page.reload();
	await expect(page.getByText(/waiting on the contributor/i)).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Credit 1 role" })).toHaveValue(`${ROLE} more`);
	await expect(page.getByRole("textbox", { name: "Credit 1 contributor" })).toHaveValue(viewerDid);

	// ── A stranger sees no ask and no DID ─────────────────────────────────────────
	const stranger = await browser.newContext();
	const strangerPage = await stranger.newPage();
	await strangerPage.goto(`/works/${work.publicId}`);
	await expect(strangerPage.getByText("You're credited — confirm?")).toHaveCount(0);
	await expect(strangerPage.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
	await expect(strangerPage.getByRole("button", { name: "Decline", exact: true })).toHaveCount(0);
	// The accepted credit renders as the name — never a bare DID to anybody.
	await expect(strangerPage.locator("section").filter({ hasText: "Credits" })).toContainText(
		VIEWER_NAME,
	);
	await expect(strangerPage.locator("section").filter({ hasText: "Credits" })).not.toContainText(
		"did:",
	);
	await stranger.close();

	await viewerContext.close();
});

/**
 * Read the session cookie out of a signed-in context, for calling the API as that account.
 *
 * The viewer's storageState carries it; `fetch` here is plain, so the cookie travels the
 * same way every other API call in these suites makes it travel.
 */
async function viewerSessionCookie(
	context: import("@playwright/test").BrowserContext,
): Promise<string> {
	const cookies = await context.cookies(API_URL);
	const session = cookies.find((c) => c.name === "session")?.value;
	expect(session, "the viewer context carries no session cookie").toBeTruthy();
	return `session=${session}`;
}
