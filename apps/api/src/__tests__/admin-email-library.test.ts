// SPDX-License-Identifier: Apache-2.0
/**
 * The admin Email Library routes: the catalog, and the one-at-a-time test send.
 *
 * 🚨 **The gate is the first subject**, as on every admin surface: both routes 401 without an
 * admin session, 401 with a main-site session, and the whole thing 404s off the admin host.
 * The catalog's *content* is pinned by id — an entry added or removed has to come through
 * here and be named, which is how the library stays a deliberate catalog rather than whatever
 * the last person remembered. The honest-render property is what the rest of the suite
 * asserts: the subject a GET carries and the subject a send carries are the same string the
 * product's own template renders, because both routes render through
 * `services/email-library.ts`, which renders through the senders.
 *
 * The send route never reaches a provider here: `sendEmail` refuses under the test runner, so
 * the send's `sent` is false and nothing is mailed — the route test proves the plumbing and
 * the recipient, never delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import app from "../index";
import { EMAIL_LIBRARY_TEST_RECIPIENT, emailLibraryEntry } from "../services/email-library";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const RUN = `eml${Date.now().toString(36)}`.slice(0, 12);
let adminCookie = "";
let siteCookie = "";

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;
	siteCookie = (
		await createAccount(`${RUN}s`, { email: `${RUN}s@example.test`, emailVerified: true })
	).cookie;
	adminCookie = (await createAdminFixture(`eml-o-${RUN}`)).cookie;
});

afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;
});

describe("the Email Library routes' gates", () => {
	it("🚨 the catalog 401s without a session and with a main-site session, and answers with one", async () => {
		const noSession = await req("/api/admin/email-library");
		expect(noSession.status).toBe(401);

		const siteSession = await req("/api/admin/email-library", {
			headers: { Cookie: siteCookie },
		});
		expect(siteSession.status).toBe(401);

		const admin = await req("/api/admin/email-library", { headers: { Cookie: adminCookie } });
		expect(admin.status).toBe(200);
	});

	it("🚨 both routes 404 off the admin host — the whole surface is invisible from the site", async () => {
		const catalog = await testFetch(
			new Request(`${SITE_HOST}/api/admin/email-library`, { headers: { Cookie: adminCookie } }),
		);
		expect(catalog.status).toBe(404);

		const send = await testFetch(
			new Request(`${SITE_HOST}/api/admin/email-library/send`, {
				method: "POST",
				headers: { Cookie: adminCookie, Origin: SITE_HOST, "Content-Type": "application/json" },
				body: JSON.stringify({ id: "signup-code" }),
			}),
		);
		expect(send.status).toBe(404);
	});

	it("🚨 the send refuses a bad origin", async () => {
		const res = await req("/api/admin/email-library/send", {
			method: "POST",
			headers: { Cookie: adminCookie, Origin: "http://evil.example" },
			body: JSON.stringify({ id: "signup-code" }),
		});
		expect(res.status).toBe(403);
	});
});

describe("GET /email-library — the catalog", () => {
	it("answers every entry, with the subject and body its own template renders", async () => {
		const res = await req("/api/admin/email-library", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			recipient: string;
			entries: { id: string; subject: string; html: string; label: string }[];
		};

		// 🚨 Pinned: an entry added or removed comes through here. New entries must name
		// their template's render function beside its sender — this is what makes the
		// library the whole catalog rather than the templates somebody remembered.
		expect(body.entries.map((e) => e.id).sort()).toEqual(
			[
				"signup-code",
				"sign-in-code",
				"admin-sign-in-code",
				"admin-invitation",
				"dmca-acknowledgment",
				"dmca-rejection",
				"dmca-counter-notice",
				"rights-request-answer",
				"purchase-receipt",
				"creator-sale-receipt",
				"refund-receipt",
				"creator-refund-receipt",
				"payout-receipt",
				"support-receipt",
				"notification-social",
				"notification-essential",
				"deadline-reminder",
			].sort(),
		);

		expect(body.recipient).toBe(EMAIL_LIBRARY_TEST_RECIPIENT);
		for (const entry of body.entries) {
			expect(entry.subject.length).toBeGreaterThan(0);
			expect(entry.html.length).toBeGreaterThan(0);
			// The honest-render property: the same string the product's own template renders.
			// Every id came from the catalog above, so the lookup is a match by construction.
			expect(entry.subject).toBe(emailLibraryEntry(entry.id)?.render().subject ?? "");
		}
	});
});

describe("POST /email-library/send — the test send", () => {
	it("🚨 sends one entry to the library's one fixed recipient, and nothing else", async () => {
		const res = await req("/api/admin/email-library/send", {
			method: "POST",
			headers: { Cookie: adminCookie, Origin: ADMIN_HOST, "Content-Type": "application/json" },
			body: JSON.stringify({ id: "purchase-receipt" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			to: string;
			subject: string;
			sent: boolean;
			messageId: string | null;
		};
		expect(body.to).toBe("admin@anthers.org");
		expect(body.subject).toBe("Your Anthers receipt: $7.83");
		// `sendEmail` refuses under the test runner, so the send answers its refusal rather
		// than mailing anything — this suite's proof is the plumbing, never a delivery.
		expect(body.sent).toBe(false);
		expect(body.messageId).toBeNull();
	});

	it("answers 400 on a malformed body and 404 for an entry the catalog does not carry", async () => {
		const bad = await req("/api/admin/email-library/send", {
			method: "POST",
			headers: { Cookie: adminCookie, Origin: ADMIN_HOST, "Content-Type": "application/json" },
			body: JSON.stringify({ wrong: true }),
		});
		expect(bad.status).toBe(400);

		const unknown = await req("/api/admin/email-library/send", {
			method: "POST",
			headers: { Cookie: adminCookie, Origin: ADMIN_HOST, "Content-Type": "application/json" },
			body: JSON.stringify({ id: "not-a-real-entry" }),
		});
		expect(unknown.status).toBe(404);
	});
});
