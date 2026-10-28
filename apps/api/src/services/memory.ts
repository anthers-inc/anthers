// SPDX-License-Identifier: Apache-2.0
/**
 * The API's own memory reading — resident bytes against the ceiling its container actually
 * enforces.
 *
 * 🚨 **This exists because the 2026-10-19 burst left the API at roughly 77% of its 1 GB
 * instance and nothing said so.** Eleven `render-paged` jobs exhausted their retries and the
 * only trace was a status page reading *degraded* the next morning; the memory high-water
 * mark was found afterwards, in the incident's own numbers. One comparable burst from an OOM
 * restart presents as a random outage, and an OOM restart is invisible in the code because
 * the kernel does it.
 *
 * **The ceiling is read from the process's cgroup, never typed.** `apps-d-1vcpu-1gb` is a
 * line in a spec file that a resize changes without this module noticing, and the number that
 * matters is the one the kernel will kill at. Where the process is not in a limited cgroup
 * (a developer's machine, a test session) there is no ceiling and no verdict — the reading is
 * still published on `/health` as bytes, and nothing alarms, because a ratio against the
 * host's memory would be a fabricated threshold.
 *
 * ⚠️ **The alarm is a threshold on a sample, not an action.** It says the retained high-water
 * mark has reached the alarm line so the decision — a larger instance, or a leak hunt — can
 * be made from evidence. It never restarts anything: App Platform restarts on OOM by itself,
 * and a cron running `doctl apps create-deployment` would be a deploy of whatever `release`
 * holds rather than maintenance.
 *
 * The sample rides two surfaces: `/health` reads it fresh on every poll (one `readFileSync`,
 * cheap enough for a route a container check hits), and {@link startMemoryWatch} samples it
 * every five minutes so the alarm does not depend on anybody looking.
 */
import { readFileSync } from "node:fs";
import { sendOperationalAlert } from "./email.js";
import { alertDue, captureError, markAlerted } from "./error-tracker.js";

/** Alarm when resident memory reaches this share of the container's ceiling. */
export const MEMORY_ALERT_RATIO = 0.85;

/** The watch's cadence. Five minutes is the status sampler's grain and fine for a slow leak. */
export const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/** The container's memory ceiling, or null where there is none to read. */
export interface MemoryReading {
	/** Resident set size, in bytes, at the moment of the sample. */
	rssBytes: number;
	/** The cgroup's memory limit in bytes, or null where the process has none. */
	limitBytes: number | null;
	/** `rssBytes / limitBytes`, or null when there is no ceiling to compare against. */
	ratio: number | null;
	/** When this reading was taken. */
	sampledAt: string;
}

/** A mail path, injectable so a suite observes the decision rather than the provider. */
export type AlarmSender = (args: { subject: string; html: string }) => Promise<{ sent: boolean }>;

/**
 * The memory ceiling this process runs under, from its own cgroup.
 *
 * cgroup v2 is `memory.max`; v1 is `memory/memory.limit_in_bytes`. Both spell an unlimited
 * group as a sentinel rather than a number — v2 as `max`, v1 as a value near `PAGE_COUNTER_MAX`
 * — and a limit that large is the absence of a limit for this purpose. An unreadable hierarchy
 * is treated the same way: no ceiling, no ratio, no invented alarm.
 */
export function readMemoryLimitBytes(
	readGroup = () => readFileSync("/proc/self/cgroup", "utf8"),
	readFile = (path: string) => readFileSync(path, "utf8"),
): number | null {
	try {
		const v2 = readGroup()
			.split("\n")
			.find((line) => line.startsWith("0::"));
		if (v2) {
			const path = v2.slice(3).trim();
			const configured = readFile(`/sys/fs/cgroup${path}/memory.max`).trim();
			if (configured !== "" && configured !== "max") {
				const limit = Number(configured);
				if (Number.isFinite(limit) && limit > 0) return limit;
			}
			return null;
		}
		// A v1 hierarchy names its controllers in the first field of every line.
		const v1 = readGroup()
			.split("\n")
			.find((line) => line.split(":")[1]?.split(",").includes("memory"));
		if (v1) {
			const path = v1.split(":")[2]?.trim() ?? "";
			const configured = readFile(`/sys/fs/cgroup/memory${path}/memory.limit_in_bytes`).trim();
			const limit = Number(configured);
			// v1's "unlimited" is a huge page-aligned value rather than a word.
			if (Number.isFinite(limit) && limit > 0 && limit < 2 ** 60) return limit;
		}
	} catch {
		// No cgroup to read — a plain host, a CI container without the files, or a platform
		// that hides them. The reading stays useful as bytes; the verdict has no ceiling.
	}
	return null;
}

/** Sample this process's resident memory against its own ceiling. Never throws. */
export function readMemory(now: Date = new Date()): MemoryReading {
	let rssBytes = 0;
	try {
		rssBytes = process.memoryUsage().rss;
	} catch {
		// A runtime that cannot answer leaves zero, which is below every threshold and so
		// fails toward silence rather than a fabricated alarm.
	}
	const limitBytes = readMemoryLimitBytes();
	return {
		rssBytes,
		limitBytes,
		ratio: limitBytes && limitBytes > 0 ? rssBytes / limitBytes : null,
		sampledAt: now.toISOString(),
	};
}

/** The verdict, pure: alarm at or above the threshold, and never without a ceiling. */
export function memoryVerdict(reading: MemoryReading): {
	alert: boolean;
	percent: number | null;
} {
	if (reading.ratio === null) return { alert: false, percent: null };
	return {
		alert: reading.ratio >= MEMORY_ALERT_RATIO,
		percent: Math.round(reading.ratio * 100),
	};
}

function megabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function memoryBody(reading: MemoryReading, percent: number): string {
	return (
		`<p style="margin:0 0 18px;">The API process is holding <strong>${megabytes(reading.rssBytes)}</strong> of its <strong>${megabytes(reading.limitBytes ?? 0)}</strong> container — ${percent}%.</p>` +
		`<p style="margin:0 0 18px;">This is a sample, not a diagnosis: a retained high-water mark from one burst and a slow leak look the same at a single reading. Watch the next samples — a plateau is the burst, a climb is the leak — before deciding between a larger instance and a hunt.</p>` +
		`<p style="margin:0;color:#6b6878;font-size:12px;">Alarms at most once a day while the reading stays above ${Math.round(MEMORY_ALERT_RATIO * 100)}%. Nothing restarts the process: App Platform already restarts it on OOM, and a scheduled deploy would not be maintenance.</p>`
	);
}

/**
 * One memory check: read, decide, and record-and-alert at most on the error tracker's
 * schedule. Quiet below the threshold — a healthy sample is not a log line.
 */
export async function runMemoryCheck(
	options: {
		now?: Date;
		send?: AlarmSender;
		read?: () => MemoryReading;
		capture?: typeof captureError;
		due?: typeof alertDue;
		mark?: typeof markAlerted;
	} = {},
): Promise<{ reading: MemoryReading; alerted: boolean; sent: boolean; percent: number | null }> {
	const now = options.now ?? new Date();
	const send = options.send ?? sendOperationalAlert;
	const capture = options.capture ?? captureError;
	const due = options.due ?? alertDue;
	const mark = options.mark ?? markAlerted;
	const reading = (options.read ?? (() => readMemory(now)))();
	const { alert, percent } = memoryVerdict(reading);
	if (!alert || percent === null) return { reading, alerted: false, sent: false, percent };

	const captured = await capture({
		source: "api",
		message: `API process memory is above ${Math.round(MEMORY_ALERT_RATIO * 100)}% of its container limit.`,
		context: { route: "process:memory", method: "SAMPLE" },
	});
	if (!captured || !(await due(captured))) {
		return { reading, alerted: true, sent: false, percent };
	}
	const subject = `API memory: ${percent}% of the instance`;
	const result = await send({ subject, html: memoryBody(reading, percent) });
	if (result.sent) {
		await mark(captured.fingerprint);
		console.warn(`[memory] operator notified: ${subject}`);
	} else {
		console.error(`[memory] warned nobody: "${subject}" — the send was refused.`);
	}
	return { reading, alerted: true, sent: result.sent, percent };
}

/**
 * Sample every five minutes for the life of the process, and return the stop function.
 *
 * The first sample runs immediately: a process that has just taken a burst should not wait
 * five minutes to say so. The interval is unref'd where the runtime supports it, so a test
 * process that imports the entry point does not stay alive for the watch's sake.
 */
export function startMemoryWatch(
	options: { intervalMs?: number; send?: AlarmSender; read?: () => MemoryReading } = {},
): () => void {
	const tick = () => {
		void runMemoryCheck({ now: new Date(), send: options.send, read: options.read }).catch((err) =>
			console.error("[memory] sample failed (non-fatal):", err),
		);
	};
	tick();
	const timer = setInterval(tick, options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}
