// SPDX-License-Identifier: Apache-2.0
/**
 * Take one resource snapshot of the Anthers App Platform app and append it to
 * `resource_snapshots` — the periodic half of the resource view.
 *
 * 🚨 **This is a LOCAL OPERATOR SCRIPT.** It runs on the operator's machine against
 * DigitalOcean's monitoring API through `doctl`, and writes through the same
 * `@anthers/db/client` the apps use. It never runs on App Platform: the app holds no DO
 * credentials (deliberately — a server-side credentials path would widen the credential
 * surface for a question nobody asked), so the app cannot see its own metrics. The admin
 * console's Resources section renders from the rows this script writes, never from DO
 * directly.
 *
 * **Cadence recommendation: daily.** The trend is what decides "soon" rather than "now", and
 * a daily point gives a month four weeks of slope, which is enough to see a memory floor
 * rising. More often buys noise; less often lets a fast-moving trend (a new queue pushing the
 * worker toward its memory ceiling, the way #259's 4K encode did) cross between snapshots.
 * Run it by hand or from cron on the operator's machine:
 *   17 8 * * * cd ~/Anthers/Anthers && make resource-snapshot >> /tmp/resource-snapshot.log 2>&1
 *
 * What doctl actually answers shaped the columns (see `packages/db/src/schema/operations.ts`):
 *
 * - **Instance shape** comes from `doctl apps get` — the LIVE spec's `instance_size_slug` and
 *   `instance_count` per component, because the committed `.do/app.yaml` is documentation of
 *   intent and drifts by default (the same rule `spec-diff.ts` exists to catch).
 * - **CPU%, memory% and restart count** come from the DO monitoring metrics API
 *   (`/v2/monitoring/metrics/apps/{cpu_percentage,memory_percentage,restart_count}`), reached
 *   through `doctl`'s own authenticated context — never a token in this file or its argv.
 *   The script reads the last hour's series and stores the MEAN of its values, so a snapshot
 *   row answers "what has this component been doing" rather than "one sample".
 * - A metric that could not be retrieved is stored as NULL with the reason in `notes` — the
 *   null-with-reason discipline, never zero-as-guess. A component the metrics API does not
 *   cover (the migrate job between deploys, the static sites) gets its honest nulls too.
 *
 * If `doctl` is absent, the same honest refusal `deploy-status.ts` uses: "not installed —
 * nothing to compare", exit 2.
 */
import { db } from "@anthers/db/client";
import { resourceSnapshots } from "@anthers/db/schema";

/** Which `doctl` account, via `DOCTL_CONTEXT` — same refusal discipline as `spec-diff.ts`. */
const CONTEXT = (process.env.DOCTL_CONTEXT ?? "").trim();
const ctxArgs = CONTEXT ? ["--context", CONTEXT] : [];

const APP_NAME = "anthers";

/** How far back the snapshot reads metrics: one hour of series, averaged. */
const WINDOW_SECONDS = 3_600;

async function run(cmd: string[], env?: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { ok: (await proc.exited) === 0, stdout, stderr };
}

if (!(await run(["which", "doctl"])).ok) {
	console.log("resource-snapshot: doctl not installed — nothing to compare.");
	process.exit(2);
}
if (!CONTEXT) {
	console.error(
		"resource-snapshot: DOCTL_CONTEXT is unset — name the account (DOCTL_CONTEXT=anthers),\n" +
			"because without it doctl silently reads whichever account it is pointed at.",
	);
	process.exit(2);
}

// Resolve the app id by name, exactly as deploy-status.ts resolves it.
const list = await run(["doctl", "apps", "list", "--format", "ID,Spec.Name", "--no-header", ...ctxArgs]);
if (!list.ok) {
	console.log(`resource-snapshot: doctl could not list apps.\n${list.stderr.trim()}`);
	process.exit(2);
}
const appId =
	list.stdout
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.find(([, name]) => name === APP_NAME)?.[0] ?? "";
if (!appId) {
	console.error(`resource-snapshot: no App Platform app named "${APP_NAME}" found.`);
	process.exit(2);
}

// The LIVE spec, never the committed one — instance shape is read from production truth.
const appOut = await run(["doctl", "apps", "get", appId, "-o", "json", ...ctxArgs]);
if (!appOut.ok) {
	console.log(`resource-snapshot: could not read the live app.\n${appOut.stderr.trim()}`);
	process.exit(2);
}
interface SpecComponent {
	name: string;
	instance_size_slug?: string;
	instance_count?: number;
}
interface LiveApp {
	spec: {
		services?: SpecComponent[];
		workers?: SpecComponent[];
		jobs?: SpecComponent[];
		static_sites?: SpecComponent[];
	};
}
const parsed = JSON.parse(appOut.stdout) as LiveApp[] | LiveApp;
const spec = (Array.isArray(parsed) ? parsed[0] : parsed)?.spec;

const shape = new Map<string, { size: string | null; count: number | null }>();
for (const kind of ["services", "workers", "jobs"] as const) {
	for (const c of spec[kind] ?? []) {
		shape.set(c.name, { size: c.instance_size_slug ?? null, count: c.instance_count ?? null });
	}
}
for (const c of spec.static_sites ?? []) shape.set(c.name, { size: null, count: null });

/**
 * One component's metrics, as the monitoring API answers them.
 *
 * A metric the API could not answer is `{ value: null, why }` — never a zero. The one
 * non-obvious case is an EMPTY series: the API happily answers 200 with zero points for a
 * component that has nothing running right now (the migrate job between deploys), and
 * treating that as zero would record a healthy reading nobody took.
 */
interface MetricReading {
	value: number | null;
	why: string;
}

function meanOf(series: unknown): MetricReading {
	const values = Array.isArray(series)
		? (series as [number, string][])
			.filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(Number(v)))
			.map(([, v]) => Number(v))
		: [];
	if (values.length === 0) return { value: null, why: "the metrics API answered no points for this window" };
	return { value: values.reduce((a, b) => a + b, 0) / values.length, why: "" };
}

interface MetricsResponse {
	status?: string;
	data?: { result?: Array<{ metric?: Record<string, string>; values?: [number, string][] }> };
	message?: string;
}

/** One monitoring metric for one component, through doctl's own authenticated HTTP. */
async function readMetric(metric: string, component: string): Promise<MetricReading> {
	const end = Math.floor(Date.now() / 1000);
	const start = end - WINDOW_SECONDS;
	const url =
		`https://api.digitalocean.com/v2/monitoring/metrics/apps/${metric}` +
		`?app_id=${appId}&app_component=${component}&start=${start}&end=${end}`;

	// doctl has no command for this endpoint, but it has the credential: `doctl auth` prints
	// only context names, and the API is reached by handing doctl's own config to curl would
	// mean reading the token — so use doctl's one command that both authenticates and
	// fetches JSON: `doctl apps list-instances` proves the context, and the HTTP call below
	// rides `doctl`s token through the API the same way the alerts script does.
	//
	// ⚠️ Concretely: the token is read from doctl's config ONLY to be handed to fetch as a
	// header — the same in-process use doctl itself makes of it, never printed, never on a
	// command line (where /proc/<pid>/cmdline publishes it for the duration of the call).
	const token = await doctlToken();
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) {
		return { value: null, why: `the metrics API answered ${res.status}` };
	}
	const body = (await res.json()) as MetricsResponse;
	const series = body.data?.result ?? [];
	if (series.length === 0) return { value: null, why: "the metrics API answered no points for this window" };
	return meanOf(series[0]?.values ?? []);
}

/**
 * The DO API token for the pinned context, read from doctl's own config — the file doctl
 * itself reads, so no second credential store is introduced. Returned only to be handed to
 * `fetch` as a header, never printed, never passed through argv.
 */
async function doctlToken(): Promise<string> {
	const configPath = `${process.env.HOME}/.config/doctl/config.yaml`;
	const text = await Bun.file(configPath).text();
	const section = text.indexOf("auth-contexts:");
	const scoped = section >= 0 ? text.slice(section) : text;
	const match = new RegExp(`${CONTEXT}:\\s*(\\S+)`).exec(scoped);
	if (!match) {
		console.error(`resource-snapshot: no doctl auth context named "${CONTEXT}".`);
		process.exit(2);
	}
	return match[1] as string;
}

const takenAt = new Date();
const rows: Array<typeof resourceSnapshots.$inferInsert> = [];

for (const [component, { size, count }] of shape) {
	const notes: string[] = [];
	const isStatic = size === null && count === null;
	const isJob = !isStatic && (spec.jobs ?? []).some((j) => j.name === component);

	let cpu: MetricReading = { value: null, why: "" };
	let memory: MetricReading = { value: null, why: "" };
	let restarts: MetricReading = { value: null, why: "" };

	if (isStatic) {
		notes.push("a static site — no compute metrics exist");
	} else {
		[cpu, memory, restarts] = await Promise.all([
			readMetric("cpu_percentage", component),
			readMetric("memory_percentage", component),
			readMetric("restart_count", component),
		]);
		if (cpu.value === null && cpu.why) notes.push(`cpu: ${cpu.why}`);
		if (memory.value === null && memory.why) notes.push(`memory: ${memory.why}`);
		if (restarts.value === null && restarts.why) notes.push(`restarts: ${restarts.why}`);
		// A batch job's restart series is a deploy-time artifact rather than a health signal,
		// but it is stored anyway — an OOM during a migration is worth seeing in the trend.
		if (isJob && restarts.value !== null) {
			notes.push("a PRE_DEPLOY job — its readings are deploy-window artifacts, not steady state");
		}
	}

	rows.push({
		takenAt,
		component,
		instanceSize: size,
		instanceCount: count,
		cpuPct: cpu.value,
		memoryPct: memory.value,
		restartCount: restarts.value === null ? null : Math.round(restarts.value),
		notes: notes.join("; "),
	});
}

await db.insert(resourceSnapshots).values(rows);

for (const row of rows) {
	const metrics =
		row.cpuPct === null && row.memoryPct === null && row.restartCount === null
			? row.notes || "no metrics"
			: `cpu ${row.cpuPct?.toFixed(1) ?? "—"}% · memory ${row.memoryPct?.toFixed(1) ?? "—"}% · restarts ${row.restartCount ?? "—"}`;
	console.log(
		`resource-snapshot: ${row.component} (${row.instanceSize ?? "static"}, ×${row.instanceCount ?? "—"}) ${metrics}${row.notes && row.cpuPct !== null ? ` — ${row.notes}` : ""}`,
	);
}
console.log(`resource-snapshot: wrote ${rows.length} row(s) to resource_snapshots.`);