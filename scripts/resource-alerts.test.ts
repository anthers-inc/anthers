// SPDX-License-Identifier: Apache-2.0
/**
 * The pure halves of the alerts wiring — the wanted policies, the YAML fragments rendered for
 * `.do/app.yaml`, and the idempotency decision. No doctl anywhere in this file; the driver is
 * `resource-alerts.ts` and these are the parts a test can run without an account.
 */
import { describe, expect, it } from "bun:test";
import {
	alertKey,
	type LiveAlert,
	missingAlerts,
	renderAlertsYaml,
	wantedAlerts,
} from "./resource-alerts-lib.js";

const EMAIL = "ops@example.test"; // not_a_real address — fixture only

describe("The wanted policies", () => {
	it("wants CPU, memory and restart alerts on the components that carry those signals", () => {
		const wanted = wantedAlerts(EMAIL);
		const pairs = wanted.map((w) => `${w.component}/${w.rule}`).sort();
		expect(pairs).toEqual([
			"api/CPU_UTILIZATION",
			"api/MEM_UTILIZATION",
			"api/RESTART_COUNT",
			"worker/CPU_UTILIZATION",
			"worker/MEM_UTILIZATION",
			"worker/RESTART_COUNT",
		]);
	});

	it("carries no policy for the migrate job or the static sites", () => {
		for (const w of wantedAlerts(EMAIL)) {
			expect(["api", "worker"]).toContain(w.component);
		}
	});

	it("reads each policy's value from the shared table's 'now' band, never its own number", () => {
		// The api's now-band for CPU is 90; the alert must fire at exactly that, because the
		// console renders 90 as "now" and an alert at a different number would disagree with
		// the screen an operator is looking at.
		const apiCpu = wantedAlerts(EMAIL).find(
			(w) => w.component === "api" && w.rule === "CPU_UTILIZATION",
		);
		expect(apiCpu?.value).toBe(90);
		const workerRestarts = wantedAlerts(EMAIL).find(
			(w) => w.component === "worker" && w.rule === "RESTART_COUNT",
		);
		expect(workerRestarts?.value).toBe(3);
	});

	it("notifies only the operational alert email", () => {
		for (const w of wantedAlerts(EMAIL)) {
			expect(w.emails).toEqual([EMAIL]);
		}
	});
});

describe("The rendered YAML fragments", () => {
	it("renders one block per component, under the component rather than the app level", () => {
		const yaml = renderAlertsYaml(EMAIL);
		expect(yaml).toContain('under the "api" component');
		expect(yaml).toContain('under the "worker" component');
		expect(yaml).not.toMatch(/^alerts:$/m); // component-level rules only
	});

	it("gives the restart-count rule the widest window, and CPU and memory five minutes", () => {
		const yaml = renderAlertsYaml(EMAIL);
		expect(yaml).toContain("rule: RESTART_COUNT");
		expect(yaml).toMatch(
			/rule: RESTART_COUNT\n\s+operator: GREATER_THAN\n\s+value: \d+\n\s+window: ONE_HOUR/,
		);
		expect(yaml).toMatch(
			/rule: CPU_UTILIZATION\n\s+operator: GREATER_THAN\n\s+value: 90\n\s+window: FIVE_MINUTES/,
		);
	});

	it("names the email and the spec-apply command, so the fragment is actionable alone", () => {
		const yaml = renderAlertsYaml(EMAIL);
		expect(yaml).toContain(EMAIL);
		expect(yaml).toContain("make spec-apply APPLY=1");
	});
});

describe("The idempotency decision", () => {
	const wanted = wantedAlerts(EMAIL);
	const live = (component: string, rule: string, emails: string[] = [EMAIL]): LiveAlert => ({
		id: `${component}-${rule}`,
		component_name: component,
		spec: { rule, disabled: false },
		emails,
	});

	it("reports nothing to do when every wanted alert is live and notifying", () => {
		const { absent, needEmail } = missingAlerts(
			wanted,
			wanted.map((w) => live(w.component, w.rule)),
		);
		expect(absent).toEqual([]);
		expect(needEmail).toEqual([]);
	});

	it("reports a wanted alert absent when the live list does not carry it", () => {
		const { absent } = missingAlerts(wanted, [live("api", "CPU_UTILIZATION")]);
		expect(absent.length).toBe(5);
		expect(absent.map((a) => alertKey(a.component, a.rule))).toContain("worker:MEM_UTILIZATION");
	});

	it("treats a disabled alert as absent, not as covering", () => {
		const disabled: LiveAlert = {
			...live("api", "CPU_UTILIZATION"),
			spec: { rule: "CPU_UTILIZATION", disabled: true },
		};
		const { absent } = missingAlerts(wanted, [
			disabled,
			...wanted.filter((w) => w.component === "worker").map((w) => live(w.component, w.rule)),
		]);
		expect(absent.map((a) => a.rule)).toContain("CPU_UTILIZATION");
	});

	it("reports an alert that exists without the operational email, rather than re-creating it", () => {
		const withoutEmail = live("api", "CPU_UTILIZATION", ["somebody-else@example.test"]); // not_a_real
		const others = wanted
			.filter((w) => alertKey(w.component, w.rule) !== "api:CPU_UTILIZATION")
			.map((w) => live(w.component, w.rule));
		const { absent, needEmail } = missingAlerts(wanted, [withoutEmail, ...others]);
		expect(absent).toEqual([]);
		expect(needEmail.map((a) => a.id)).toEqual(["api-CPU_UTILIZATION"]);
	});

	it("keys a live app-level alert apart from a component-level one with the same rule", () => {
		expect(alertKey("api", "RESTART_COUNT")).not.toBe(alertKey("app", "RESTART_COUNT"));
	});
});
