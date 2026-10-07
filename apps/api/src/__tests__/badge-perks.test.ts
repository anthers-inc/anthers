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
import { badgePerks, badges, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { taxCodeForBadge } from "../services/billing";
import {
	DONATION_TAX_CODE,
	STREAMED_SUBSCRIPTION_TAX_CODE,
} from "@anthers/shared/tax-codes";
import { BADGE_PERK_KINDS, mostTaxablePerkKind } from "@anthers/shared/badge-art";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, giveWorkAFile } from "./work-fixtures.js";

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
		const account = await createAccount(`bp_creator_${RUN}`, { fields: { isCreator: true } });
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

	it("carries the fixed category list with a friendly line each", () => {
		expect(BADGE_PERK_KINDS.length).toBeGreaterThanOrEqual(4);
		for (const k of BADGE_PERK_KINDS) {
			expect(k.friendly.length).toBeGreaterThan(20);
			expect(k.taxCode).toMatch(/^txcd_/);
		}
	});

	it("orders the kinds most-taxable first", () => {
		// The ordering IS the posture: a physical good outranks a service, which outranks
		// recognition. One assertion over every prefix combination would be exhaustive;
		// the binding cases are pinned.
		expect(mostTaxablePerkKind(["recognition", "physical_good"])?.id).toBe("physical_good");
		expect(mostTaxablePerkKind(["recognition", "service"])?.id).toBe("service");
		expect(mostTaxablePerkKind(["recognition"])?.id).toBe("recognition");
		expect(mostTaxablePerkKind(["community", "service", "physical_good"])?.id).toBe("physical_good");
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
	});

	it("🚨 codes a gate-clearing, perk-free rung as the streamed subscription", async () => {
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
			// 🚨 And a TAGGED perk outranks the gate read: the most-taxable-kind ordering is
			// applied to tags first, so a rung clearing a gate AND tagged recognition codes
			// as recognition. This is the posture decision the docblock records — a tag is
			// the creator affirming what the rung carries extra to access, and recognition
			// (a gratuity-like good) is the lesser sale beside access that is already
			// charged on the gate's own terms.
			await putPerks([{ kind: "recognition", label: "Name in credits" }]);
			expect(await taxCodeForBadge(badgeId)).toBe("txcd_90000001");
		} finally {
			await db.delete(works).where(eq(works.id, work.id));
		}
	});

	it("codes a rung with neither gate nor perk as a donation", async () => {
		await putPerks([]);
		expect(await taxCodeForBadge(badgeId)).toBe(DONATION_TAX_CODE);
	});

	it("refuses another creator's rung", async () => {
		const other = await createAccount(`bp_other_${RUN}`, { fields: { isCreator: true } });
		const res = await putPerks([{ kind: "service", label: "X" }], other.cookie);
		expect(res.status).toBe(404);
	});
});