// SPDX-License-Identifier: Apache-2.0
/**
 * The alert policies this build wants on the Anthers App Platform app — pure data plus the
 * two pure decisions the wiring script needs, so the script itself stays a thin doctl driver.
 *
 * What doctl actually offers shaped this table, and it is narrower than the dashboard:
 * `doctl monitoring alert create` builds **Droplet** alert policies (`v1/insights/droplet/*`
 * entity types) — it cannot name an App Platform component. App Platform's own metric alerts
 * (`CPU_UTILIZATION`, `MEM_UTILIZATION`, `RESTART_COUNT`) live in the **app spec**, on the
 * component, and the only doctl write path is `doctl apps update --spec`, which is the
 * command this repository forbids running by hand because it clobbers valueless secrets and
 * drops undeclared fields. So this script does NOT create the alerts itself:
 *
 * 1. It renders the alert block this build wants, as a YAML fragment an operator can paste
 *    into `.do/app.yaml` (or apply with `make spec-apply`, which merges live secrets first) —
 *    `renderAlertsYaml`.
 * 2. It verifies, after the operator applies it, that the live app carries each wanted alert
 *    and that each one's destinations include `OPS_ALERT_EMAIL` — `missingAlerts`, driven by
 *    `doctl apps list-alerts`, and `updateAlertDestinations` for the email half. Setting
 *    destinations is the one thing doctl CAN do directly (`doctl apps
 *    update-alert-destinations`), and it is idempotent by nature.
 *
 * The bands mirror `@anthers/shared/resource-thresholds`'s "now" thresholds: an alert is the
 * wake-a-person tripwire, so it fires at "now", never at "soon" — the trend view in the admin
 * console is what decides "soon".
 */
import { RESOURCE_THRESHOLDS } from "@anthers/shared/resource-thresholds";

/** The three App Platform component-level metric alert rules this build wants wired. */
export type AppAlertRule = "CPU_UTILIZATION" | "MEM_UTILIZATION" | "RESTART_COUNT";

/** One alert policy this build wants on one component. */
export interface WantedAlert {
	/** The component name as the app spec names it (api, worker). */
	component: string;
	rule: AppAlertRule;
	/** `GREATER_THAN` — every policy here fires on exceeding, never on dropping under. */
	operator: "GREATER_THAN";
	/** The threshold; mirrors the "now" band for that component and signal. */
	value: number;
	/** The App Platform window the condition must hold for. */
	window: "FIVE_MINUTES" | "TEN_MINUTES" | "THIRTY_MINUTES" | "ONE_HOUR";
	/** The email every alert notifies — `.do/app.yaml`'s `OPS_ALERT_EMAIL`. */
	emails: string[];
}

/** The signal each App Platform rule corresponds to, in the shared thresholds' vocabulary. */
const RULE_SIGNAL: Record<AppAlertRule, "cpu" | "memory" | "restarts"> = {
	CPU_UTILIZATION: "cpu",
	MEM_UTILIZATION: "memory",
	RESTART_COUNT: "restarts",
};

/**
 * The alerts this build wants: CPU, memory and restart-count policies on every component that
 * carries those signals in the shared threshold table (api and worker; the migrate job is a
 * batch job whose duration signal has no App Platform rule, and the static sites have no
 * compute at all). Each policy's value is the component's "now" band for its signal, read
 * from the shared table rather than retyped — the one thing an alert must never do is fire
 * at a different number than the console renders.
 */
export function wantedAlerts(opsAlertEmail: string): WantedAlert[] {
	const wanted: WantedAlert[] = [];
	for (const row of RESOURCE_THRESHOLDS) {
		if (row.kind !== "service" && row.kind !== "worker") continue;
		for (const rule of ["CPU_UTILIZATION", "MEM_UTILIZATION", "RESTART_COUNT"] as AppAlertRule[]) {
			const band = row.bands.find((b) => b.signal === RULE_SIGNAL[rule]);
			if (!band) continue;
			wanted.push({
				component: row.component,
				rule,
				operator: "GREATER_THAN",
				value: band.nowAt,
				window: "FIVE_MINUTES",
				emails: [opsAlertEmail],
			});
		}
	}
	return wanted;
}

/**
 * Render the wanted alerts as the YAML fragments to paste into `.do/app.yaml`, one block per
 * component — App Platform's metric rules (`CPU_UTILIZATION` and friends) are component-level
 * only, so they belong under the component in the spec, not under the app-level `alerts:`
 * array (which carries deployment and domain events). Each fragment carries a comment naming
 * the component it belongs under.
 *
 * A restart-count alert holds its value over a wider window than a CPU one: restarts are
 * discrete events and one restart is deploy noise, so the window is the "in a day" the shared
 * table's unit names, approximated by the longest window App Platform offers.
 */
export function renderAlertsYaml(opsAlertEmail: string): string {
	const byComponent = new Map<string, WantedAlert[]>();
	for (const alert of wantedAlerts(opsAlertEmail)) {
		const list = byComponent.get(alert.component) ?? [];
		list.push(alert);
		byComponent.set(alert.component, list);
	}

	const blocks: string[] = [
		"# App Platform metric alerts — rendered by scripts/resource-alerts.ts.",
		"# Paste each block inside its named component in .do/app.yaml (component-level rules",
		`# only), then apply with make spec-apply APPLY=1. Each alert emails ${opsAlertEmail}`,
		"# (OPS_ALERT_EMAIL), and each value is the shared threshold table's 'now' band.",
	];
	for (const [component, alerts] of byComponent) {
		blocks.push(`# — under the "${component}" component:`);
		blocks.push("  alerts:");
		for (const alert of alerts) {
			const window = alert.rule === "RESTART_COUNT" ? "ONE_HOUR" : alert.window;
			blocks.push(
				`    - rule: ${alert.rule}`,
				`      operator: ${alert.operator}`,
				`      value: ${alert.value}`,
				`      window: ${window}`,
			);
		}
	}
	return blocks.join("\n");
}

/**
 * The key an existing live alert is identified by: component plus rule. App Platform assigns
 * each alert an id, but the pair is what "already exists" means — running the wiring twice
 * must not read the second pass as needing a create.
 */
export function alertKey(component: string, rule: string): string {
	return `${component}:${rule}`;
}

/** One live alert as `doctl apps list-alerts` reports it (the fields this script reads). */
export interface LiveAlert {
	/** The DO-assigned alert id, needed for the destinations call. */
	id: string;
	/** Null for app-level alerts; the component name for component-level ones. */
	component_name: string | null;
	spec: {
		rule?: string;
		disabled?: boolean;
	} | null;
	emails?: string[];
}

/**
 * Which wanted alerts are missing from the live app's alerts, and which exist but do not
 * notify the operational alert email. The idempotency decision: a run that finds nothing in
 * either list does nothing, and a run that finds a wanted alert already present never asks
 * for it to be created again.
 *
 * ⚠️ `disabled: true` counts as present-but-not-covering: a disabled alert is the same
 * silence as a missing one, so it lands in `absent` and the operator is told to re-enable
 * rather than re-create.
 */
export function missingAlerts(
	wanted: WantedAlert[],
	live: LiveAlert[],
): { absent: WantedAlert[]; needEmail: LiveAlert[] } {
	const liveByKey = new Map<string, LiveAlert>();
	for (const alert of live) {
		if (alert.spec?.rule)
			liveByKey.set(alertKey(alert.component_name ?? "app", alert.spec.rule), alert);
	}

	const absent: WantedAlert[] = [];
	const needEmail: LiveAlert[] = [];
	for (const w of wanted) {
		const existing = liveByKey.get(alertKey(w.component, w.rule));
		if (!existing || existing.spec?.disabled) {
			absent.push(w);
			continue;
		}
		if (!w.emails.every((e) => existing.emails?.includes(e))) needEmail.push(existing);
	}
	return { absent, needEmail };
}
