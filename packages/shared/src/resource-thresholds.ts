// SPDX-License-Identifier: Apache-2.0
/**
 * Resource thresholds — the per-component bands the admin console's Resources section renders,
 * and the place a band or a remedy is added.
 *
 * Pure (no clock, no DOM, no I/O), like `content-rating.ts` and `sales-tax-thresholds.ts`, so
 * the API, the admin app and the snapshot scripts read the same table rather than each
 * hard-coding its own. The bands are **engineering defaults, not measured facts**: they were
 * picked to be defensible at Anthers' current size and are revisable in this file alone — what
 * is frozen here is the *shape* (per component, per signal, a "soon" band and a "now" band, and
 * a remedy that names which lever moves), never the numbers.
 *
 * What the table encodes:
 *
 * 1. **"Soon" is a budget and "now" is a ceiling.** A component sitting inside its soon band is
 *    not in trouble; it is where the *next* scaling decision gets made from evidence rather
 *    than from something breaking. `bandFor` answers `now` only when the now-threshold is
 *    crossed, and `soon` only between the two.
 * 2. **The remedy names one of three levers**: a bigger instance (`bigger`), more instances
 *    (`more`), or moving the work off the instance (`off`). Which lever a signal argues for is
 *    part of the threshold, not a follow-on judgment — a cue rendered without its remedy
 *    suggests "more" by default, which is exactly the guess this table exists to replace.
 * 3. **A scale-out cue carries its precondition.** Scaling the api's instance count multiplies
 *    its Postgres connections per instance, and the connection budget binds before CPU does, so
 *    any `more` remedy on the api states that precondition beside it. Preconditions ride with
 *    the signal row so a rendered cue cannot appear without the thing that must be true first.
 * 4. **Static sites have no compute signals at all.** `web` and `admin` are static sites on
 *    App Platform's CDN — no instance, no CPU, no memory, no restarts. They are carried as rows
 *    with empty signal lists rather than omitted, so the console can say why they read
 *    differently instead of silently missing them.
 *
 * ⚠️ **The migrate job's signal is its run duration, not steady-state CPU.** A PRE_DEPLOY job
 * runs to completion and exits; its CPU is spiky by design and a sustained-CPU band would fire
 * on every deploy. The row carries a duration signal whose bands are minutes, with the
 * thresholds deliberately wide because a deploy-time migration being *slow* is a deploy
 * problem, not a steady-state one.
 */

/** The App Platform components the resource view covers. */
export type ResourceComponent = "api" | "worker" | "migrate" | "web" | "admin";

/**
 * Which lever a crossed threshold argues for.
 *
 * - `bigger` — a larger instance size on the same component.
 * - `more` — a higher instance count on the same component.
 * - `off` — move the work somewhere that is not this instance at all.
 */
export type ResourceRemedy = "bigger" | "more" | "off";

/** The signals the resource view renders, as doctl and the snapshot table carry them. */
export type ResourceSignal = "cpu" | "memory" | "restarts" | "duration";

/**
 * One band row: what value crosses "soon", what crosses "now", and which lever that argues for.
 *
 * `soonAt` is inclusive (a value equal to it is already "soon"); `nowAt` likewise. A signal with
 * no honest band for this component is simply absent from its list.
 */
export interface ResourceBand {
	signal: ResourceSignal;
	/** The unit the thresholds are measured in, for the operator's screen. */
	unit: string;
	/** At or above this, the signal reads "upgrade soon". */
	soonAt: number;
	/** At or above this, the signal reads "upgrade now". */
	nowAt: number;
	remedy: ResourceRemedy;
	/**
	 * What must be true before the remedy is applied, stated beside the cue rather than
	 * implied. Null where no precondition exists.
	 */
	precondition: string | null;
}

/** One component's threshold row: its signals, and the note the console renders under them. */
export interface ResourceThresholds {
	component: ResourceComponent;
	/** The component's kind, which decides whether it has compute signals at all. */
	kind: "service" | "worker" | "job" | "static";
	/** Empty for a static site, which is the honesty rather than an omission. */
	bands: readonly ResourceBand[];
	/** One line the console renders under the component's signals. */
	note: string;
}

/**
 * The api's Postgres connection precondition, the one live scale-out gate. The api holds a
 * postgres-js pool (max 3) plus the worker holds its own, against a managed cluster with a low
 * `max_connections`; every added instance is another pool, so the connection budget binds
 * before CPU does.
 */
export const API_SCALE_OUT_PRECONDITION =
	"The Postgres connection budget binds before CPU does: every added api instance is another connection pool, so count the cluster's max_connections against all components' pools before raising instance_count.";

/**
 * Every component's thresholds. Read a row, do not restate it: the endpoint, the page and the
 * scripts all render this transcription rather than each carrying a copy.
 */
export const RESOURCE_THRESHOLDS: readonly ResourceThresholds[] = [
	{
		component: "api",
		kind: "service",
		bands: [
			{
				signal: "cpu",
				unit: "% sustained",
				soonAt: 70,
				nowAt: 90,
				remedy: "bigger",
				precondition: null,
			},
			{
				signal: "memory",
				unit: "% sustained",
				soonAt: 75,
				nowAt: 90,
				remedy: "bigger",
				precondition: null,
			},
			{
				signal: "restarts",
				unit: "in a day",
				soonAt: 2,
				nowAt: 3,
				// Restart count doubles as the OOM detector: a container killed and restarted
				// repeatedly is the signature of memory pressure on a size too small for the
				// workload, so the remedy is the bigger instance rather than a scale-out.
				remedy: "bigger",
				precondition: null,
			},
		],
		// Any CPU scale-out cue on the api carries the connection-budget precondition, so the
		// note names the single-instance shape the bands assume.
		note: "One instance today. A second would multiply Postgres connections, so scale-out carries the connection-budget precondition rendered beside it.",
	},
	{
		component: "worker",
		kind: "worker",
		bands: [
			{
				signal: "cpu",
				unit: "% sustained",
				soonAt: 70,
				nowAt: 90,
				remedy: "bigger",
				precondition: null,
			},
			{
				signal: "memory",
				unit: "% sustained",
				soonAt: 75,
				nowAt: 90,
				// The evidence-driven history is #259: a 4K encode plus its scan peaked near
				// 565 MB against a 512 MB plan, which moved the worker to basic-s (2 GB).
				// Memory is the worker's signal — the queues' peaks add up, and the transcode's
				// one-thread pin means CPU pressure shows up as queue latency, not CPU%.
				remedy: "bigger",
				precondition: null,
			},
			{
				signal: "restarts",
				unit: "in a day",
				soonAt: 2,
				nowAt: 3,
				remedy: "bigger",
				precondition: null,
			},
		],
		note: "Memory is the worker's signal: media queue peaks add up (a 4K encode plus its scan once peaked near 565 MB against 512 MB, #259), which is what moved it to basic-s. ffmpeg is pinned to one thread, so CPU pressure shows as queue latency rather than CPU%.",
	},
	{
		component: "migrate",
		kind: "job",
		bands: [
			{
				signal: "duration",
				unit: "minutes per run",
				soonAt: 10,
				nowAt: 30,
				// A PRE_DEPLOY job's slow run blocks every deploy behind it, so the remedy is
				// the bigger instance (a faster run), never a second instance — the job is
				// one run per deploy by construction.
				remedy: "bigger",
				precondition: null,
			},
		],
		note: "A batch job, so its signal is run duration rather than steady-state CPU: a slow migration blocks every deploy behind it, and its CPU is spiky by design.",
	},
	{
		component: "web",
		kind: "static",
		bands: [],
		note: "A static site on the CDN — no instance, no CPU, no memory, no restarts. There is nothing to size here.",
	},
	{
		component: "admin",
		kind: "static",
		bands: [],
		note: "A static site on the CDN — no instance, no CPU, no memory, no restarts. There is nothing to size here.",
	},
];

/**
 * Which band a value sits in: "now" at or above the now-threshold, "soon" at or above the
 * soon-threshold, and null below both or for a signal the component does not carry.
 */
export function bandFor(
	component: ResourceComponent,
	signal: ResourceSignal,
	value: number,
): "soon" | "now" | null {
	const row = RESOURCE_THRESHOLDS.find((r) => r.component === component);
	const band = row?.bands.find((b) => b.signal === signal);
	if (!band) return null;
	if (value >= band.nowAt) return "now";
	if (value >= band.soonAt) return "soon";
	return null;
}

/** One component's thresholds, or null for a component the table does not carry. */
export function thresholdsFor(component: string): ResourceThresholds | null {
	return RESOURCE_THRESHOLDS.find((r) => r.component === component) ?? null;
}
