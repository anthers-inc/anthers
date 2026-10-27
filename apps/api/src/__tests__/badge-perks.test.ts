// SPDX-License-Identifier: Apache-2.0
/**
 * Badge perks — the tagging surface, the most-taxable-kind ordering, and what they do
 * to a rung's tax code.
 *
 * 🚨 The tax-code paths are exercised through `taxCodeForBadge` directly, with Works and
 * perks written by this suite and cleaned up in `afterAll` — never through a Stripe call,
 * which no unit suite makes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badgePerks, works } from "@anthers/db/schema";
import { BADGE_PERK_KINDS, mostTaxablePerkKind } from "@anthers/shared/badge-art";
import { STREAMED_SUBSCRIPTION_TAX_CODE, SUPPORT_TAX_CODE } from "@anthers/shared/tax-codes";
import { eq } from "drizzle-orm";
import app from "../index";
import { taxCodeForBadge } from "../services/billing";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { giveWorkAFile, insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

let cookie: string;
let userId = 0;
let badgeId = 0;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function putPerks(perks: unknown[], withCookie = cookie) {
	return req(`/api/subscriptions/badges/${badgeId}/perks`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: withCookie },
		body: JSON.stringify({ perks }),
	});
}

describe("badge perks", () => {
	beforeAll(async () => {
		const account = await createAccount(`bp_creator_${RUN}`, { fields: { creatorMode: true } });
		cookie = account.cookie;
		userId = account.userId;
		const res = await req("/api/subscriptions/badges", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ threshold: "5.00", label: "Perked" }),
		});
		const badge = (await res.json()) as { badge?: { id?: number } };
		badgeId = badge.badge?.id ?? 0;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// Works this suite inserted (with their access rows) and the perk rows cascade
		// with the account; the explicit deletes name what does NOT cascade.
		await db.delete(badgePerks).where(eq(badgePerks.badgeId, badgeId));
	});

	it("carries the fixed category list with short examples for each", () => {
		expect(BADGE_PERK_KINDS.length).toBe(7);
		for (const k of BADGE_PERK_KINDS) {
			expect(k.examples.length).toBeGreaterThan(10);
			expect(k.taxCode).toMatch(/^txcd_/);
		}
		// The two kinds the first list lacked, and the floor a rung that sells nothing names.
		expect(BADGE_PERK_KINDS.map((k) => k.id)).toContain("digital_good");
		expect(BADGE_PERK_KINDS.map((k) => k.id)).toContain("discount");
		expect(BADGE_PERK_KINDS.at(-1)?.id).toBe("support");
	});

	it("orders the kinds most-taxable first", () => {
		// The ordering IS the posture: physical goods outrank digital and community, which
		// outrank a service, and the three kinds that share the support code sit at the tail.
		// One assertion over every prefix combination would be exhaustive; the binding cases
		// are pinned.
		expect(mostTaxablePerkKind(["recognition", "physical_good"])?.id).toBe("physical_good");
		expect(mostTaxablePerkKind(["service", "digital_good"])?.id).toBe("digital_good");
		expect(mostTaxablePerkKind(["service", "community"])?.id).toBe("community");
		expect(mostTaxablePerkKind(["recognition", "service"])?.id).toBe("service");
		expect(mostTaxablePerkKind(["support", "discount"])?.id).toBe("discount");
		expect(mostTaxablePerkKind(["recognition"])?.id).toBe("recognition");
		expect(mostTaxablePerkKind(["community", "service", "physical_good"])?.id).toBe(
			"physical_good",
		);
		expect(mostTaxablePerkKind([])).toBeNull();
	});

	it("stores a whole-list replace, and replaces rather than accumulating", async () => {
		const first = await putPerks([{ kind: "service", label: "Feedback on one track" }]);
		expect(first.status).toBe(200);
		const second = await putPerks([
			{ kind: "physical_good", label: "Sticker sheet" },
			{ kind: "recognition", label: "Name in the credits" },
		]);
		const body = (await second.json()) as { perks: { kind: string; label: string }[] };
		expect(body.perks.map((p) => p.kind)).toEqual(["physical_good", "recognition"]);
		const rows = await db.select().from(badgePerks).where(eq(badgePerks.badgeId, badgeId));
		expect(rows.length).toBe(2); // the first put's row was replaced, not kept
	});

	it("reads the stored list back in ladder order — the editor's own load", async () => {
		// 🚨 Without this read the maker opened every rung empty, and its whole-list save
		// then replaced the creator's perks with nothing. The order is the one they typed.
		await putPerks([
			{ kind: "physical_good", label: "Sticker sheet" },
			{ kind: "recognition", label: "Name in the credits" },
		]);
		const res = await req(`/api/subscriptions/badges/${badgeId}/perks`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { perks: { kind: string; label: string }[] };
		expect(body.perks.map((p) => p.label)).toEqual(["Sticker sheet", "Name in the credits"]);
	});

	it("🚨 refuses an unknown kind", async () => {
		const res = await putPerks([{ kind: "cash-back", label: "Nope" }]);
		expect(res.status).toBe(400);
	});

	it("replaces with an empty list, which is a rung carrying no perk", async () => {
		const res = await putPerks([]);
		expect(res.status).toBe(200);
		const rows = await db.select().from(badgePerks).where(eq(badgePerks.badgeId, badgeId));
		expect(rows.length).toBe(0);
	});

	it("🚨 codes a perk-carrying rung at its most-taxable kind", async () => {
		await putPerks([{ kind: "physical_good", label: "Print" }]);
		expect(await taxCodeForBadge(badgeId)).toBe("txcd_99999999");
		await putPerks([{ kind: "service", label: "Feedback" }]);
		expect(await taxCodeForBadge(badgeId)).toBe("txcd_20030000");
		await putPerks([{ kind: "community", label: "Discord" }]);
		expect(await taxCodeForBadge(badgeId)).toBe("txcd_20030000");
	});

	it("🚨 codes a Digital perk at the streamed-subscription code", async () => {
		// One dropdown cannot name the medium, so digital goods take the same code gated
		// Works do rather than a per-medium download code the kind cannot choose.
		await putPerks([{ kind: "digital_good", label: "PDF songbook" }]);
		expect(await taxCodeForBadge(badgeId)).toBe(STREAMED_SUBSCRIPTION_TAX_CODE);
	});

	it("codes a Discount or a Support rung at the support code", async () => {
		await putPerks([{ kind: "discount", label: "20% off the shop" }]);
		expect(await taxCodeForBadge(badgeId)).toBe(SUPPORT_TAX_CODE);
		await putPerks([{ kind: "support", label: "Just backing the work" }]);
		expect(await taxCodeForBadge(badgeId)).toBe(SUPPORT_TAX_CODE);
	});

	it("🚨 codes a gate-clearing rung as the streamed subscription — access outranks a gratuity tag", async () => {
		// The previous test left perks on this rung; this one is about the NO-perk read.
		await putPerks([]);
		const work = await insertWork({
			creatorId: userId,
			type: "video",
			title: `Perk gate ${RUN}`,
			access: [
				{ threshold: 5, allow: true, price: "0" },
				{ threshold: 0, allow: false, price: "0" },
			],
		});
		try {
			await giveWorkAFile(work.id);
			expect(await taxCodeForBadge(badgeId)).toBe(STREAMED_SUBSCRIPTION_TAX_CODE);
			// 🚨 And access outranks a gratuity tag: the same rung, tagged recognition, still
			// codes as the streamed subscription, because its supporters genuinely receive
			// gated access and a name-in-credits must not understate that (Parker's
			// access-weighted reading, 2026-10-07). A goods or service tag would outrank
			// the access; a gratuity does not.
			await putPerks([{ kind: "recognition", label: "Name in credits" }]);
			expect(await taxCodeForBadge(badgeId)).toBe(STREAMED_SUBSCRIPTION_TAX_CODE);
		} finally {
			await db.delete(works).where(eq(works.id, work.id));
		}
	});

	it("codes a rung with neither gate nor perk as support", async () => {
		// The editor refuses to save a rung in this state; the fallback stays for rows that
		// predate the rule, and it must land on the same code an explicit Support row does.
		await putPerks([]);
		expect(await taxCodeForBadge(badgeId)).toBe(SUPPORT_TAX_CODE);
	});

	it("refuses another creator's rung", async () => {
		const other = await createAccount(`bp_other_${RUN}`, { fields: { creatorMode: true } });
		const res = await putPerks([{ kind: "service", label: "X" }], other.cookie);
		expect(res.status).toBe(404);
		const read = await req(`/api/subscriptions/badges/${badgeId}/perks`, {
			headers: { Cookie: other.cookie },
		});
		expect(read.status).toBe(404);
	});
});
