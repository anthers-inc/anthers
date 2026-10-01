// SPDX-License-Identifier: Apache-2.0
/**
 * The resource-threshold table — the bands, the remedies, and the honesty the static rows owe.
 *
 * Pinned here:
 *
 * 1. **Bands**: `bandFor` answers "now" only at or above the now-threshold, "soon" between the
 *    two, and null below both or for a signal the component does not carry.
 * 2. **Remedies and preconditions**: the api's restart and CPU rows name the bigger instance,
 *    the migrate row names duration rather than steady-state CPU, and — the one live
 *    precondition — any `more` remedy on the api carries the Postgres connection budget.
 * 3. **Static-site honesty**: `web` and `admin` carry empty band lists rather than being
 *    omitted, and `bandFor` answers null for every signal on them.
 *
 * The numbers themselves are engineering defaults, revisable in `resource-thresholds.ts` alone;
 * what this suite pins is the shape and the honesty, not the exact figures.
 */
import { describe, expect, it } from "bun:test";
import {
	bandFor,
	RESOURCE_THRESHOLDS,
	thresholdsFor,
	type ResourceSignal,
} from "./resource-thresholds";

describe("Band resolution", () => {
	it("answers now only at or above the now-threshold", () => {
		expect(bandFor("api", "cpu", 90)).toBe("now");
		expect(bandFor("api", "cpu", 95)).toBe("now");
		expect(bandFor("api", "cpu", 89.9)).not.toBe("now");
	});

	it("answers soon between the two thresholds, inclusive at the soon edge", () => {
		expect(bandFor("api", "cpu", 70)).toBe("soon");
		expect(bandFor("api", "cpu", 89.9)).toBe("soon");
		expect(bandFor("api", "cpu", 69.9)).toBeNull();
		expect(bandFor("api", "cpu", 0)).toBeNull();
	});

	it("reads the worker's memory bands, whose evidence-driven history is #259's peak", () => {
		expect(bandFor("worker", "memory", 75)).toBe("soon");
		expect(bandFor("worker", "memory", 90)).toBe("now");
	});

	it("answers null for a signal the component does not carry", () => {
		// The migrate job has no steady-state bands at all; duration is its only signal.
		expect(bandFor("migrate", "cpu", 95)).toBeNull();
		expect(bandFor("migrate", "memory", 95)).toBeNull();
		expect(bandFor("migrate", "duration", 10)).toBe("soon");
		expect(bandFor("migrate", "duration", 30)).toBe("now");
	});
});

describe("Static-site honesty", () => {
	it("carries web and admin with empty band lists rather than omitting them", () => {
		for (const component of ["web", "admin"] as const) {
			const row = thresholdsFor(component);
			expect(row).not.toBeNull();
			expect(row?.kind).toBe("static");
			expect(row?.bands).toHaveLength(0);
			expect(row?.note).toContain("static site");
		}
	});

	it("answers null for every signal on a static site", () => {
		for (const signal of ["cpu", "memory", "restarts", "duration"] as ResourceSignal[]) {
			expect(bandFor("web", signal, 100)).toBeNull();
			expect(bandFor("admin", signal, 100)).toBeNull();
		}
	});
});

describe("Remedies and preconditions", () => {
	it("answers a threshold row for every component the table carries", () => {
		const components = RESOURCE_THRESHOLDS.map((r) => r.component).sort();
		expect(components).toEqual(["admin", "api", "migrate", "web", "worker"]);
	});

	it("names the bigger instance for the api's compute signals, not more instances", () => {
		const api = thresholdsFor("api");
		expect(api?.bands.map((b) => b.remedy)).not.toContain("more");
		expect(api?.bands.map((b) => b.remedy)).not.toContain("off");
	});

	it("answers null from thresholdsFor for a component the table does not carry", () => {
		expect(thresholdsFor("anthersdb")).toBeNull();
		expect(thresholdsFor("")).toBeNull();
	});

	it("would carry the connection-budget precondition on any api scale-out remedy", () => {
		// The live precondition is written so it rides beside the cue: any api band whose
		// remedy is "more" must carry it. Today none is (the api's bands are all "bigger"),
		// but the day one is added, this test is what forces the precondition along with it.
		const api = thresholdsFor("api");
		expect(api).not.toBeNull();
		for (const band of api!.bands) {
			if (band.remedy === "more") {
				expect(band.precondition).not.toBeNull();
				expect(band.precondition).toContain("connection");
			}
		}
	});

	it("states the restart band as the OOM detector with a bigger-instance remedy", () => {
		for (const component of ["api", "worker"] as const) {
			const row = thresholdsFor(component);
			const restarts = row?.bands.find((b) => b.signal === "restarts");
			expect(restarts?.remedy).toBe("bigger");
			expect(restarts?.unit).toBe("in a day");
		}
	});

	it("carries the duration signal on the migrate job rather than steady-state CPU", () => {
		const migrate = thresholdsFor("migrate");
		expect(migrate?.bands.map((b) => b.signal)).toEqual(["duration"]);
		expect(migrate?.bands[0]?.unit).toContain("minutes");
	});

	it("leaves no band without a unit, so no rendered cue can read unitless", () => {
		for (const row of RESOURCE_THRESHOLDS) {
			for (const band of row.bands) {
				expect(band.unit.length).toBeGreaterThan(0);
			}
		}
	});
});