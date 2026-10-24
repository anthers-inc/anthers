// SPDX-License-Identifier: Apache-2.0
/**
 * The access table's draft mapping — the half of the gate model the server cannot check.
 *
 * A stored gate names its rung (`badgeId`). Matching by that reference rather than by the
 * stored amount is what keeps a gate attached to its rung after a reprice; the amount
 * fallback exists only for rows written before the reference existed, which
 * `db:gate-badges` fills in.
 */
import { describe, expect, it } from "bun:test";
import type { CreatorBadge } from "../../lib/types";
import { buildAccessRows, serializeAccessRows } from "./AccessTables";

const rungs = [
	{ id: 11, threshold: "3.00", label: "Low" },
	{ id: 12, threshold: "6.00", label: "High" },
] as CreatorBadge[];

describe("buildAccessRows", () => {
	it("opens with the Everyone baseline and one row per rung", () => {
		const rows = buildAccessRows(rungs, null);
		expect(rows.map((r) => [r.badgeId, r.threshold])).toEqual([
			[null, 0],
			[11, 3],
			[12, 6],
		]);
	});

	it("matches a stored gate by its rung, so a repriced rung keeps its gate", () => {
		// The rung is $5 now and the stored gate still says $3; the gate belongs to the
		// rung, and the row the creator sees is the rung's current amount.
		const existing = [{ badgeId: 11, threshold: 3, allow: true, price: "2.00" }];
		const row = buildAccessRows(rungs, existing).find((r) => r.badgeId === 11);
		expect(row).toMatchObject({ threshold: 3, allow: true, price: "2.00" });
	});

	it("falls back to the amount for a row written before the rung reference", () => {
		const existing = [{ threshold: 6, allow: true, price: "0" }];
		const row = buildAccessRows(rungs, existing).find((r) => r.badgeId === 12);
		expect(row?.allow).toBe(true);
	});
});

describe("serializeAccessRows", () => {
	it("carries the rung id, and a null on the baseline", () => {
		const rows = buildAccessRows(rungs, null);
		rows[0].allow = true;
		rows[1].allow = true;

		expect(serializeAccessRows(rows)).toEqual([
			{ badgeId: null, threshold: 0, allow: true, price: "0" },
			{ badgeId: 11, threshold: 3, allow: true, price: "0" },
			{ badgeId: 12, threshold: 6, allow: false, price: "0" },
		]);
	});
});
