// SPDX-License-Identifier: Apache-2.0
/**
 * Wire the App Platform metric alerts (CPU, memory, restart count) to the operational alert
 * email — the alerts half of the resource view.
 *
 * 🚨 **Alerts wake a person, and that is all they do.** The trend view in the admin console's
 * Resources section is what decides when to upgrade; an alert exists so a threshold crossed
 * at 3am does not wait for the next snapshot to be noticed. Do not widen an alert's window or
 * lower its value to make it quieter — fix the threshold in the shared table instead, where
 * the console reads the same number.
 *
 * What this script does, in order:
 *
 * 1. Refuses without `doctl`, the same honest "not installed — nothing to compare" line
 *    `deploy-status.ts` uses, and requires `DOCTL_CONTEXT=anthers` the same way
 *    `spec-diff.ts` does.
 * 2. Renders the YAML fragments the operator pastes into `.do/app.yaml` under each
 *    component and applies with `make spec-apply APPLY=1`. 🚨 It does NOT run
 *    `doctl apps update --spec` itself, ever — that command is this repository's forbidden
 *    one, and the reasoning is `scripts/spec-apply.ts`'s docblock. Alerts live in the spec,
 *    so creating them means a spec apply, which is an operator's deliberate act.
 * 3. Reads the live alerts with `doctl apps list-alerts` and reports which wanted alerts
 *    are absent (or disabled), and which exist without the operational alert email in their
 *    destinations. For that second case it can act directly: `doctl apps
 *    update-alert-destinations` sets an alert's emails, and it is idempotent by nature —
 *    running it twice leaves one alert with the same destinations, which is the idempotency
 *    this script owes.
 *
 * The wanted policies and the idempotency decision live in `resource-alerts-lib.ts`, pure
 * and unit-tested there; this file is the doctl driver.
 */
const CONTEXT = (process.env.DOCTL_CONTEXT ?? "").trim();
const ctxArgs = CONTEXT ? ["--context", CONTEXT] : [];

/** `.do/app.yaml`'s operational alert key: `OPS_ALERT_EMAIL`, the worker's alert mailbox. */
const OPS_ALERT_EMAIL = "admin@anthers.org";

const APP_NAME = "anthers";

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { ok: (await proc.exited) === 0, stdout, stderr };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder for the driver body below
void ctxArgs;

if (!(await run(["which", "doctl"])).ok) {
	console.log("resource-alerts: doctl not installed — nothing to compare.");
	process.exit(2);
}
if (!CONTEXT) {
	console.error(
		"resource-alerts: DOCTL_CONTEXT is unset — name the account (DOCTL_CONTEXT=anthers),\n" +
			"because without it doctl silently reads whichever account it is pointed at.",
	);
	process.exit(2);
}

import { type LiveAlert, missingAlerts, renderAlertsYaml, wantedAlerts } from "./resource-alerts-lib.js";

// Resolve the app id by name, exactly as deploy-status.ts does.
const list = await run(["doctl", "apps", "list", "--format", "ID,Spec.Name", "--no-header", ...ctxArgs]);
if (!list.ok) {
	console.log(`resource-alerts: doctl could not list apps.\n${list.stderr.trim()}`);
	process.exit(2);
}
const appId =
	list.stdout
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.find(([, name]) => name === APP_NAME)?.[0] ?? "";
if (!appId) {
	console.error(`resource-alerts: no App Platform app named "${APP_NAME}" found.`);
	process.exit(2);
}

// The step the operator takes by hand: paste the fragments, apply with spec-apply.
console.log(renderAlertsYaml(OPS_ALERT_EMAIL));
console.log("");
console.log("Paste each block inside its named component in .do/app.yaml, then run:");
console.log("  make spec-apply APPLY=1");
console.log("");

// Then verify what is actually live, and fix destinations where doctl can.
const alertsOut = await run(["doctl", "apps", "list-alerts", appId, "-o", "json", ...ctxArgs]);
if (!alertsOut.ok) {
	console.log(`resource-alerts: could not list live alerts.\n${alertsOut.stderr.trim()}`);
	process.exit(2);
}
let live: LiveAlert[] = [];
try {
	live = JSON.parse(alertsOut.stdout) as LiveAlert[];
} catch {
	// doctl prints `null` (not `[]`) for an app with no alerts at all.
	live = [];
}

const { absent, needEmail } = missingAlerts(wantedAlerts(OPS_ALERT_EMAIL), live);

if (absent.length > 0) {
	console.log("Missing or disabled live alerts (create them with the spec above):");
	for (const a of absent) {
		console.log(`  ${a.component} / ${a.rule} > ${a.value} (${a.window})`);
	}
}
if (needEmail.length > 0) {
	console.log(`Setting destinations on ${needEmail.length} alert(s) to ${OPS_ALERT_EMAIL}:`);
	for (const alert of needEmail) {
		const dest = await run([
			"doctl",
			"apps",
			"update-alert-destinations",
			appId,
			alert.id,
			"--app-alert-destinations",
			// A path is what doctl takes, so write the destinations JSON to a temp file.
			(await (async () => {
				const path = `/tmp/opencode/alert-dest-${alert.id}.json`;
				await Bun.write(path, JSON.stringify({ emails: [OPS_ALERT_EMAIL], slack_webhooks: [] }));
				return path;
			})()),
			...ctxArgs,
		]);
		if (dest.ok) console.log(`  ✓ ${alert.component_name ?? "app"} ${alert.spec?.rule}`);
		else console.log(`  ✗ ${alert.spec?.rule}: ${dest.stderr.trim()}`);
	}
}
if (absent.length === 0 && needEmail.length === 0) {
	console.log(
		`resource-alerts: every wanted alert is live and notifies ${OPS_ALERT_EMAIL} ✓ (nothing to do)`,
	);
}