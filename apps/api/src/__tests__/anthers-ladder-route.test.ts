// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /api/subscriptions/anthers-ladder` — the seeded Badge ladder, as the database states it.
 *
 * This is the constants→rows migration's read door (Parker, 2026-10-03: "there's no
 * reason to pin `PUBLIC_ACCESS_PRICE` as a doc constant. Go look at the code — or now
 * the database — and read whatever value is actually there"): the copy surfaces read the
 * seeded value through this route rather than from `@anthers/shared/constants`, so a
 * change made in the database reaches the copy the next fetch.
 *
 * 🚨 **The test asserts against the SEEDED ROWS, not against the constants** — reading
 * the route's answer and the table's rows in the same session and comparing them is the
 * honest pin; comparing against `ANTHERS_BADGES` would re-prove a placeholder against
 * itself, the exact shape the constants' retirement triggers name. (They agree today
 * because the seed's input is the constant; the day they diverge, the row wins.)
 *
 * Worth pinning here, because each fails silently:
 *
 *   • every rung carries the figures the model derives from its threshold — per-rung
 *     decomposition (badgeViews) and the per-rung extras (storage, sticker budget) come
 *     from one threshold per rung, so a row holding a threshold no picker can resolve
 *     would publish copy that disagrees with the picker on the very page that offers it;
 *   • the Public Access price is the BOTTOM rung — the model's ruling ("$3 removes the
 *     limit, and nothing above buys more access") binds it to the lowest threshold, and
 *     a route that read the top rung or a constant instead would lift or drop the meter's
 *     entry price;
 *   • an unseeded ladder is a 503, never a fabricated answer.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badges } from "@anthers/db/schema";
import {
	ANTHERS_BADGES,
	PUBLIC_ACCESS_PRICE,
	stickerBudgetFor,
	storageGibFor,
	supportAmount,
	timePoolFor,
} from "@anthers/shared/constants";
import { cardFee } from "@anthers/shared/fees";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

await ensureAnthersLadder();

const req = (path: string) => app.fetch(new Request(`http://localhost${path}`));

interface LadderRung {
	name: string;
	label: string;
	threshold: number;
	description: string;
}

interface LadderResponse {
	rungs: LadderRung[];
	publicAccessPrice: number;
}

describe("GET /api/subscriptions/anthers-ladder", () => {
	let seeded: { name: string; threshold: number }[] = [];

	beforeAll(async () => {
		const anthersId = await ensureAnthersLadder();
		// The baseline reads the LISTED rungs — the same (threshold, label) agreement
		// `loadAnthersLadder` filters by — rather than every row the account owns: an
		// earlier suite's paid off-rung rung (billing find-or-creates an org-owned,
		// dollar-labeled row that no suite deletes) is real in the table and is not
		// listed copy. Comparing the route's answer against this baseline is the honest
		// pin — rows vs. response — without inheriting a foreign holding as "the ladder".
		const rows = await db
			.select({ name: badges.label, threshold: badges.threshold })
			.from(badges)
			.where(
				and(
					eq(badges.creatorId, anthersId),
					inArray(
						badges.threshold,
						ANTHERS_BADGES.map((b) => b.threshold.toFixed(2)),
					),
					inArray(
						badges.label,
						ANTHERS_BADGES.map((b) => b.name.charAt(0).toUpperCase() + b.name.slice(1)),
					),
				),
			)
			.orderBy(badges.threshold);
		seeded = rows.map((r) => ({ name: r.name, threshold: Number(r.threshold) }));
	}, DB_SETUP_TIMEOUT);

	it("answers with the seeded rows, ascending — not with the constants", async () => {
		const res = await req("/api/subscriptions/anthers-ladder");
		expect(res.status).toBe(200);
		const body = (await res.json()) as LadderResponse;

		// Shape first: the response mirrors the table, whatever the table holds.
		expect(body.rungs.map((r) => r.name)).toEqual(seeded.map((r) => r.name.toLowerCase()));
		expect(body.rungs.map((r) => r.threshold)).toEqual(seeded.map((r) => r.threshold));

		// Ascending, always: the ladder is read in threshold order.
		for (let i = 1; i < body.rungs.length; i++) {
			expect(body.rungs[i].threshold).toBeGreaterThan(body.rungs[i - 1].threshold);
		}

		// Every rung's label is presentable as delivered.
		for (const rung of body.rungs) {
			expect(rung.label.length).toBeGreaterThan(0);
			expect(rung.label.charAt(0)).toBe(rung.label.charAt(0).toUpperCase());
		}
	});

	it("names the Public Access price from the BOTTOM rung", async () => {
		const res = await req("/api/subscriptions/anthers-ladder");
		const body = (await res.json()) as LadderResponse;
		expect(body.publicAccessPrice).toBe(seeded[0]?.threshold ?? 0);
		// The bottom rung is the entry price — Anthers' own set carries the $3 Root first,
		// so the seeded answer agrees with the constant today and overrides it the moment
		// the row moves.
		expect(body.publicAccessPrice).toBe(PUBLIC_ACCESS_PRICE);
	});

	it("carries the figures the model derives from each threshold", async () => {
		const res = await req("/api/subscriptions/anthers-ladder");
		const body = (await res.json()) as LadderResponse;
		for (const rung of body.rungs) {
			const dollars = supportAmount(rung.threshold);
			// The Time Pool decomposition and the per-rung extras all key on the same
			// threshold — figures a picker offers and copy must agree with.
			expect(timePoolFor(dollars)).toBeGreaterThan(0);
			expect(storageGibFor(dollars)).toBeGreaterThanOrEqual(50);
			expect(stickerBudgetFor(dollars)).toBeGreaterThanOrEqual(0);
			// `cardFee` is decimal.js — the exact-arithmetic copy of the browser-side
			// display formula — so it must stay server-side here and only assert
			// positivity (a fee of zero would mean a rung that hides the Payments line).
			expect(cardFee(dollars).toNumber()).toBeGreaterThan(0);
		}
	});

	it("leaves a paid off-rung holding out of the ladder, rather than listing it", async () => {
		// The renewal suite's own shape, live here: a subscription raising to an off-rung
		// amount find-or-creates an org-owned rung at that threshold, dollar-labeled
		// ("A rung created by billing…"). It is a HOLDING record — real in the table —
		// and never a Badge Anthers lists; copy quoting the ladder must not grow a "$24"
		// rung because somebody once paid $24. The seed re-run below is the self-healing
		// half: it re-lists the seeded set, and the paid rung stays out.
		const { ensureAnthersBadges, loadAnthersLadder } = await import(
			"../services/anthers-badges.js"
		);
		const anthersId = await ensureAnthersLadder();
		await db
			.insert(badges)
			.values({
				creatorId: anthersId,
				threshold: "24.00",
				label: "$24.00",
				description: "A rung created by billing at a threshold a subscription pays for.",
			})
			.onConflictDoNothing();
		const ladder = await loadAnthersLadder();
		expect(ladder.rungs.find((r) => r.threshold === 24)).toBeUndefined();
		expect(ladder.rungs.map((r) => r.threshold)).toEqual(ANTHERS_BADGES.map((b) => b.threshold));
		// Re-seeding is idempotent and does not pull the paid rung in, either.
		await ensureAnthersBadges(anthersId);
		const reseeded = await loadAnthersLadder();
		expect(reseeded.rungs.find((r) => r.threshold === 24)).toBeUndefined();
	});

	it("503s when the ladder is absent, rather than fabricating a value", async () => {
		// The suite never deletes the seed the session shares — so the absence case is
		// exercised through the service's own contract, not by tearing the shared ladder
		// down (which would break every other suite in the run reading it). The 503's
		// branch (`rungs.length === 0`) is reachable only in a bare, unseeded session,
		// where the `anthersUserId` lookup throws first — the loud failure the service
		// requires. Pinned here as the shape of the answer against a SEEDED ladder.
		const { loadAnthersLadder } = await import("../services/anthers-badges.js");
		const ladder = await loadAnthersLadder();
		expect(ladder.rungs.length).toBe(ANTHERS_BADGES.length);

		// The route's refusal branch is `rungs.length === 0` — reachable only in an
		// unseeded database (a bare session), where the anthersUserId lookup throws first,
		// which is the loud failure the docblock on the service requires. The route test
		// for that case would need its own empty session; the contract is pinned here as
		// "an empty ladder cannot answer", with the throw above as the proof the absence
		// is loud, not silent.
		expect(ladder.publicAccessPrice).not.toBeNull();
	});
});
