// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Creator preview: seeing your own gating the way a reader sees it.
 *
 * 🚨 **The property that makes this safe is that a preview can only ever SUBTRACT.** It
 * applies only to Works the requester created — who already sees everything of theirs — so
 * every substituted answer is *less* permissive than the real one. The guard is per Work
 * rather than per request, and the test that matters most is the one where a stranger asks
 * for the most generous preview they can spell and gets nothing for it.
 *
 * The other reason this file exists is drift. A preview that reimplemented gate logic
 * would start lying in exactly the situation it is for — so it drives the same
 * `resolveAccessSync` as everything else, with a substituted context, and these assertions
 * are what keep that true.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `cp_c_${id}`;
const strangerName = `cp_s_${id}`;

/** Free to everyone. */
const FREE = [{ threshold: 0, allow: true, price: "0" }];
/** Locked at the baseline, open at $2 given to this creator. */
const GATED_AT_2 = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 2, allow: true, price: "0" },
];
/** Buyable by anyone, at a price. */
const FOR_SALE = [{ threshold: 0, allow: true, price: "5.00" }];

let creatorAuth: Record<string, string>;
let creatorCookie: string;
let strangerCookie: string;
let gatedId = 0;
let freeId = 0;
let saleId = 0;

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

async function makeWork(title: string, access: unknown): Promise<number> {
	const created = await req("/api/content/works", {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({ type: "audio", title, maturity: "general" }),
	});
	expect(created.status).toBe(201);
	const workId = (await created.json()).work.id as number;
	const patched = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: creatorAuth,
		body: JSON.stringify({ seedAccess: access, streamEnabled: true, visibility: "released" }),
	});
	expect(patched.status).toBe(200);
	return workId;
}

/**
 * Ask for a Work as somebody, optionally through a preview.
 *
 * ⚠️ `access` is optional in the return type on purpose, because the endpoint genuinely
 * returns two shapes: an **owner** gets `serializeWork` — full media keys, the editable
 * access table, and no `access` verdict, since an owner never needed one — and everybody
 * else gets `serializeWorkForViewer`. Asking for a preview is what moves a creator from
 * the first shape to the second, which is the whole mechanism.
 */
async function view(workId: number, cookie: string, query = "") {
	const res = await req(`/api/content/works/${workId}${query}`, { headers: { Cookie: cookie } });
	expect(res.status).toBe(200);
	return (await res.json()).work as {
		access?: { canAccess: boolean; reason: string; requiresPurchase: boolean };
		seedAccess?: unknown;
		sourceKey: string;
	};
}

describe("creator preview", () => {
	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${strangerName})`);
		creatorCookie = await signUp(creatorName);
		await enablePayouts(creatorName);
		strangerCookie = await signUp(strangerName);
		await enablePayouts(strangerName);
		creatorAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie };

		gatedId = await makeWork(`Gated ${id}`, GATED_AT_2);
		freeId = await makeWork(`Free ${id}`, FREE);
		saleId = await makeWork(`For sale ${id}`, FOR_SALE);
	}, DB_SETUP_TIMEOUT);

	// ── The safety property ────────────────────────────────────────────────────

	it("🚨 a stranger cannot preview their way into a Work they don't own", async () => {
		// The most generous preview that can be spelled: rich, and claiming to have bought
		// it. On somebody else's Work it must do exactly nothing.
		expect((await view(gatedId, strangerCookie)).access?.canAccess).toBe(false);
		const tried = await view(gatedId, strangerCookie, "?previewAs=99&previewOwned=1");
		expect(tried.access?.canAccess).toBe(false);
		expect(tried.access?.reason).toBe("gated");

		// And on a Work they DO have access to, a preview does not take it away either —
		// it simply isn't theirs to preview.
		expect((await view(freeId, strangerCookie, "?previewAs=out")).access?.canAccess).toBe(true);
	});

	// ── What the creator sees ──────────────────────────────────────────────────

	it("without a preview, a creator gets the owner shape and nothing changes", async () => {
		const work = await view(gatedId, creatorCookie);
		// No verdict at all — an owner is not a viewer, and this is the shape the Studio
		// edits against. If a preview ever started leaking into the default response, this
		// is the assertion that would notice.
		expect(work.access).toBeUndefined();
		expect(work.seedAccess).toBeDefined();
	});

	it("previewing signed-out shows the gate as a stranger meets it", async () => {
		const work = await view(gatedId, creatorCookie, "?previewAs=out");
		expect(work.access?.canAccess).toBe(false);
		// `login_required` rather than `gated`: a signed-out viewer's first problem is that
		// nobody knows who they are. Getting this distinction from the real resolver rather
		// than inventing it in the preview is the whole point of substituting the context.
		expect(work.access?.reason).toBe("login_required");
	});

	it("previewing below the gate is locked, and at the gate is open", async () => {
		expect((await view(gatedId, creatorCookie, "?previewAs=1")).access?.canAccess).toBe(false);
		expect((await view(gatedId, creatorCookie, "?previewAs=2")).access?.canAccess).toBe(true);
		// Above the gate too — a ladder is cumulative, and a preview that only worked on the
		// exact rung would misrepresent every supporter above it.
		expect((await view(gatedId, creatorCookie, "?previewAs=5")).access?.canAccess).toBe(true);
	});

	it("the deliverable is withheld in a locked preview, exactly as it would be", async () => {
		// Not merely a different `canAccess` flag: the creator should see the locked page
		// their reader sees, media URLs and all. A preview that reported "locked" while
		// still handing over the payload would be lying about the thing it exists to show.
		const work = await view(gatedId, creatorCookie, "?previewAs=0");
		expect(work.access?.canAccess).toBe(false);
		expect(work.sourceKey).toBe("");
	});

	it("previews the bought and not-bought states of a priced Work", async () => {
		const notBought = await view(saleId, creatorCookie, "?previewAs=0");
		expect(notBought.access?.canAccess).toBe(false);
		expect(notBought.access?.requiresPurchase).toBe(true);

		const bought = await view(saleId, creatorCookie, "?previewAs=0&previewOwned=1");
		expect(bought.access?.canAccess).toBe(true);
		expect(bought.access?.reason).toBe("purchased");
	});

	it("ignores a malformed preview rather than guessing at one", async () => {
		// Failing back to the truth is the only safe direction: a preview nobody asked for
		// is confusing, but a preview that silently resolved as somebody else would be
		// worse than either.
		// ⚠️ `?previewAs=1.5` sat in this list until 2026-08-16 and has MOVED to the test
		// below. It was malformed only because a Seed was indivisible; $1.50 is now an
		// ordinary amount for a supporter to give, and refusing to preview it would deny a
		// creator a view of their own ladder in exactly the case they most need it.
		for (const q of ["?previewAs=", "?previewAs=lots", "?previewAs=-3", "?previewAs=abc"]) {
			const work = await view(gatedId, creatorCookie, q);
			// Back to the owner shape — the truth — rather than a preview at some guessed
			// level. Note this also means the owner short-circuit is intact for these.
			expect(work.access, `for ${q}`).toBeUndefined();
			expect(work.sourceKey, `for ${q}`).toBeDefined();
		}
	});

	/**
	 * 🚨 The case the whole-Seed model could not express, and the one a creator setting a
	 * $2.50 Badge needs most.
	 *
	 * It is asserted as a *preview that resolves*, not merely as "not rejected": the
	 * distinction matters because the old integer guard failed back to the owner shape,
	 * which looks like success — full media keys, no error — and is the truth rather than
	 * the preview. So the assertion is that `access` is PRESENT and denies, which the owner
	 * shape can never produce.
	 */
	it("previews an amount carrying cents, which the whole-Seed guard refused", async () => {
		const work = await view(gatedId, creatorCookie, "?previewAs=1.50");
		expect(work.access).toBeDefined();
		expect(work.access?.canAccess).toBe(false);
		// And the media payload is withheld, which is the point of previewing at all.
		expect(work.sourceKey).toBeFalsy();
	});

	// ── The catalog, which is where a creator actually looks ───────────────────

	it("applies to the creator's whole Catalog at once", async () => {
		const res = await req(`/api/content/catalog/${creatorName}?previewAs=0`, {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const { works } = (await res.json()) as {
			works: { id: number; access: { canAccess: boolean } }[];
		};
		const byId = new Map(works.map((w) => [w.id, w.access.canAccess]));
		// The free one stays open and the gated one shuts — the point being that a preview
		// shows the *mix*, which is what a creator is actually trying to see.
		expect(byId.get(freeId)).toBe(true);
		expect(byId.get(gatedId)).toBe(false);
	});
});
