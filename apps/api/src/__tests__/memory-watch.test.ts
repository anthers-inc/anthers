// SPDX-License-Identifier: Apache-2.0
/**
 * The memory reading decides, and the tests assert the decisions rather than the sends.
 *
 * The suite covers the moments that would otherwise need a production OOM: the ceiling read
 * (cgroup v2, v1's page-aligned "unlimited", and a host with no cgroup at all), the verdict
 * at the boundary, and the alarm's one-per-day budget. The reading and the mail are injected,
 * so no test allocates a gigabyte or pages anybody.
 */
import { describe, expect, it } from "bun:test";
import type { CaptureResult } from "../services/error-tracker.js";
import {
	MEMORY_ALERT_RATIO,
	type MemoryReading,
	memoryVerdict,
	readMemory,
	readMemoryLimitBytes,
	runMemoryCheck,
} from "../services/memory.js";

const base = new Date("2026-10-19T12:00:00Z");
const GB = 1024 * 1024 * 1024;

function readingOf(rssBytes: number, limitBytes: number | null): MemoryReading {
	return {
		rssBytes,
		limitBytes,
		ratio: limitBytes ? rssBytes / limitBytes : null,
		sampledAt: base.toISOString(),
	};
}

function recorder() {
	const calls: Array<{ subject: string; html: string }> = [];
	return {
		calls,
		send: async (args: { subject: string; html: string }) => {
			calls.push(args);
			return { sent: true };
		},
	};
}

describe("readMemoryLimitBytes", () => {
	it("reads a finite cgroup v2 ceiling", () => {
		expect(
			readMemoryLimitBytes(
				() => "0::/user.slice/session.scope",
				() => "1073741824\n",
			),
		).toBe(GB);
	});

	it("treats v2's max as no ceiling rather than a number", () => {
		expect(
			readMemoryLimitBytes(
				() => "0::/",
				() => "max\n",
			),
		).toBeNull();
	});

	it("reads the v1 hierarchy and treats its page-aligned sentinel as no ceiling", () => {
		expect(
			readMemoryLimitBytes(
				() => "4:memory:/docker/abc",
				() => "1073741824\n",
			),
		).toBe(GB);
		expect(
			readMemoryLimitBytes(
				() => "4:memory:/docker/abc",
				() => "9223372036854771712\n",
			),
		).toBeNull();
	});

	it("answers null where there is no cgroup to read", () => {
		expect(
			readMemoryLimitBytes(
				() => "",
				() => "",
			),
		).toBeNull();
		expect(
			readMemoryLimitBytes(
				() => {
					throw new Error("no cgroup");
				},
				() => "",
			),
		).toBeNull();
	});
});

describe("memoryVerdict", () => {
	it("alarms at the boundary and stays quiet below it", () => {
		expect(MEMORY_ALERT_RATIO).toBe(0.85);
		expect(memoryVerdict(readingOf(840, 1000)).alert).toBeFalse();
		expect(memoryVerdict(readingOf(850, 1000)).alert).toBeTrue();
		expect(memoryVerdict(readingOf(770, 1000))).toEqual({ alert: false, percent: 77 });
	});

	it("never alarms without a ceiling, because there is no ratio to judge", () => {
		expect(memoryVerdict(readingOf(GB * 4, null))).toEqual({ alert: false, percent: null });
	});
});

describe("readMemory", () => {
	it("samples this process and reports bytes on every call", () => {
		const reading = readMemory(base);
		expect(reading.rssBytes).toBeGreaterThan(0);
		expect(reading.sampledAt).toBe(base.toISOString());
		if (reading.limitBytes !== null) {
			expect(reading.ratio).toBeCloseTo(reading.rssBytes / reading.limitBytes, 6);
		}
	});
});

describe("runMemoryCheck", () => {
	it("is quiet below the threshold: no capture, no mail", async () => {
		const { send, calls } = recorder();
		let captured = 0;
		const result = await runMemoryCheck({
			now: base,
			send,
			read: () => readingOf(GB * 0.5, GB),
			capture: async (): Promise<CaptureResult> => {
				captured += 1;
				return { firstSeen: true, fingerprint: "fp", count: 1 };
			},
		});
		expect(result.alerted).toBeFalse();
		expect(result.sent).toBeFalse();
		expect(captured).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("captures and pages once above the threshold, and marks the fingerprint", async () => {
		const { send, calls } = recorder();
		const marked: string[] = [];
		const result = await runMemoryCheck({
			now: base,
			send,
			read: () => readingOf(GB * 0.9, GB),
			capture: async (): Promise<CaptureResult> => ({
				firstSeen: true,
				fingerprint: "fp",
				count: 1,
			}),
			due: async () => true,
			mark: async (fingerprint) => {
				marked.push(fingerprint);
			},
		});
		expect(result.alerted).toBeTrue();
		expect(result.sent).toBeTrue();
		expect(result.percent).toBe(90);
		expect(calls).toHaveLength(1);
		expect(calls[0].subject).toContain("90%");
		expect(marked).toEqual(["fp"]);
	});

	it("records but does not page while the resurface window is closed", async () => {
		const { send, calls } = recorder();
		const result = await runMemoryCheck({
			now: base,
			send,
			read: () => readingOf(GB * 0.9, GB),
			capture: async (): Promise<CaptureResult> => ({
				firstSeen: false,
				fingerprint: "fp",
				count: 9,
			}),
			due: async () => false,
		});
		expect(result.alerted).toBeTrue();
		expect(result.sent).toBeFalse();
		expect(calls).toHaveLength(0);
	});

	it("does not capture without a ceiling to compare against", async () => {
		let captured = 0;
		const result = await runMemoryCheck({
			now: base,
			read: () => readingOf(GB * 4, null),
			capture: async (): Promise<CaptureResult> => {
				captured += 1;
				return { firstSeen: true, fingerprint: "fp", count: 1 };
			},
		});
		expect(result.alerted).toBeFalse();
		expect(captured).toBe(0);
	});
});
