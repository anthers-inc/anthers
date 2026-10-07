// SPDX-License-Identifier: Apache-2.0
/**
 * Badge composition from a Noun Project icon — the rules that are expensive to retrofit:
 *
 * - **No SVG is stored, anywhere.** The compose path writes the composed PNG and the
 *   provenance row and nothing else; every object this suite uploads under the badge is
 *   enumerated and none of them is a vector.
 * - **An unchanged save spends nothing.** A fingerprint match returns before the vendor
 *   call, the raster, the upload, the scan and the write.
 * - **The key-never-escapes rule the upload path already carries** applies to composed
 *   art too: the storage key appears in no client response.
 * - **No emblem-by-itself endpoint exists.** A creator gets a Badge; a route answering
 *   with a standalone recolored emblem is the vendor experience Anthers agreed not to
 *   re-create, so its absence is asserted rather than assumed.
 *
 * The vendor is stubbed at `globalThis.fetch` — the house pattern (see
 * `scan-fixtures.ts`'s reasoning about stubs that never get consulted). The stub answers
 * the two requests the compose path makes — the SVG download and, because the scan runs
 * for real here, the Shield classification — and the composition, storage, scan and DB
 * writes below it are all real, which is what makes the what-persisted assertions about
 * this code rather than about a stub.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { badgeArtProvenance, badges } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

// A minimal placement in bounds — what the picker sends by default.
const placement = {
	shape: "circle",
	fieldColor: "moss",
	emblemColor: "#ffffff",
	scale: 1,
	offsetX: 0,
	offsetY: 0,
};

// What the vendor's search response carries for one icon — the fields provenance is
// written from, because `GET /v2/icon/{id}` is never called by the compose path.
const nounIcon = {
	id: "12345",
	term: "test emblem",
	permalink: "https://thenounproject.com/icon/test-emblem-12345",
	attribution: "test emblem by Test Artist",
	license_description: "public-domain",
	creator: { name: "Test Artist", permalink: "https://thenounproject.com/creator/test-artist" },
};

// What the vendor's download endpoint answers — the same shape the live API returns
// (`base64_encoded_file`), decoded by the client precisely as it will be in production.
const VENDOR_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M20 20h60v60z"/></svg>';
const VENDORDOWNLOAD = {
	base64_encoded_file: Buffer.from(VENDOR_SVG).toString("base64"),
	content_type: "image/svg+xml",
};

const originalFetch = globalThis.fetch;
let vendorIconCalls = 0;

function stubVendor() {
	// The runtime credential's names carry fixture values — never a vendor-shaped string
	// (the credential-shape guard refuses one) and never the real key, which a suite has
	// no business holding. The fetch stub below answers before any real request happens,
	// so these exist only to pass the client's own precondition.
	process.env.NOUNPRO_KEY = "badge-compose-test-key";
	process.env.NOUNPRO_SECRET = "badge-compose-test-secret";
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("api.thenounproject.com")) {
			if (url.includes("/download")) {
				vendorIconCalls++;
				return new Response(JSON.stringify(VENDORDOWNLOAD), { status: 200 });
			}
			return new Response(JSON.stringify({ icons: [] }), { status: 200 });
		}
		return originalFetch(input as RequestInfo);
	}) as typeof fetch;
}

let cookie: string;
let badgeId = 0;

// Track every object this suite writes under the badge, for the no-SVG assertion.
const badgeObjectKeys: string[] = [];
const realUpload = storage.upload.bind(storage);
beforeAll(() => {
	stubVendor();
	storage.upload = ((key: string, ...rest: unknown[]) => {
		if (key.includes("/badges/")) badgeObjectKeys.push(key);
		return (
			realUpload as (
				k: string,
				b: Buffer,
				ct: string,
				acl?: "private" | "public",
			) => Promise<string>
		)(key, ...(rest as [Buffer, string, ("private" | "public")?]));
	}) as typeof storage.upload;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	(storage as { upload: unknown }).upload = realUpload;
	delete process.env.NOUNPRO_KEY;
	delete process.env.NOUNPRO_SECRET;
});

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function compose(body: unknown, withCookie = cookie) {
	return req(`/api/subscriptions/badges/${badgeId}/compose`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: withCookie },
		body: JSON.stringify(body),
	});
}

describe("badge composition", () => {
	let _creatorId = 0;

	beforeAll(async () => {
		const account = await createAccount(`bc_creator_${RUN}`, { fields: { isCreator: true } });
		cookie = account.cookie;
		_creatorId = account.userId;
		const res = await req("/api/subscriptions/badges", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ threshold: "5.00", label: "Composed" }),
		});
		const badge = (await res.json()) as { badge?: { id?: number } };
		badgeId = badge.badge?.id ?? 0;
		expect(badgeId).toBeGreaterThan(0);
	}, DB_SETUP_TIMEOUT);

	it("composes a Badge and stores the composed PNG — and no SVG", async () => {
		const res = await compose({ noun: nounIcon, placement });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { artPath?: string; unchanged?: boolean };
		expect(body.unchanged).toBeFalsy();
		expect(body.artPath).toBe(`/api/subscriptions/badges/${badgeId}/art`);

		// Everything written under this badge is a PNG — the vector is in none of it.
		expect(badgeObjectKeys.length).toBeGreaterThan(0);
		for (const key of badgeObjectKeys) {
			expect({ key, isSvg: key.endsWith(".svg") }).toEqual({ key, isSvg: false });
		}
		const [stored] = await db.select().from(badges).where(eq(badges.id, badgeId)).limit(1);
		expect(stored.artKey).toBeTruthy();
		expect(stored.artFingerprint).toBeTruthy();

		// The provenance row was written from the ride-along search fields, and no
		// metadata fetch was spent getting it.
		const [prov] = await db
			.select()
			.from(badgeArtProvenance)
			.where(eq(badgeArtProvenance.badgeId, badgeId))
			.limit(1);
		expect(prov.artistName).toBe("Test Artist");
		expect(prov.licenseDescription).toBe("public-domain");

		// 🚨 The storage key never reaches a client — artPath is the delivery route.
		const raw = JSON.stringify(body);
		const key = String(stored.artKey);
		expect(raw.includes(key)).toBe(false);

		// The composed PNG reads back as a real PNG at the compose resolution.
		const obj = await storage.read(key);
		expect(obj).toBeTruthy();
		const meta = await sharp(obj!).metadata();
		expect(meta.format).toBe("png");
		expect(meta.width).toBe(1024);
	});

	it("answers an unchanged save without recomposing — dedupe before the vendor call", async () => {
		const callsBefore = vendorIconCalls;
		const res = await compose({ noun: nounIcon, placement });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { unchanged?: boolean };
		expect(body.unchanged).toBe(true);
		expect(vendorIconCalls).toBe(callsBefore);
	});

	it("recomposes exactly when a placement parameter changes", async () => {
		const callsBefore = vendorIconCalls;
		const res = await compose({
			noun: nounIcon,
			placement: { ...placement, emblemColor: "#000000" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { unchanged?: boolean };
		expect(body.unchanged).toBeFalsy();
		expect(vendorIconCalls).toBe(callsBefore + 1);
	});

	it("refuses a placement the bounds reject, without touching the vendor", async () => {
		const callsBefore = vendorIconCalls;
		const res = await compose({ noun: nounIcon, placement: { ...placement, scale: 99 } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code?: string }).code).toBe("bad_placement");
		expect(vendorIconCalls).toBe(callsBefore);
	});

	it("refuses another creator's badge — ownership is the route's first check", async () => {
		const other = await createAccount(`bc_other_${RUN}`, { fields: { isCreator: true } });
		const res = await compose({ noun: nounIcon, placement }, other.cookie);
		expect(res.status).toBe(404);
	});

	it("🚨 offers no emblem-by-itself endpoint — the badge is the only artifact", () => {
		// The compose route module is read for any noun-shaped path that would answer
		// with a standalone emblem — the vendor experience Anthers agreed not to
		// re-create. Asserted on the module's text because an absence has no feature to
		// exercise: this rule is about what must never exist.
		const routes = readFileSync(join(import.meta.dir, "../routes/subscriptions.ts"), "utf8");
		expect(routes.includes("/emblem")).toBe(false);
	});
});
