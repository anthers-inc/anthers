// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The abuse probe never runs unattended, and never takes a password off the command line.
 *
 * 🛑 Settled by Parker on 2026-08-27: *"we should never run unattended tests of content
 * reports, especially safety or abuse ones. At most we should be able to explicitly run a
 * single-email test to ensure the system is functioning, which then needs its database cruft
 * immediately cleared out. We never want to automate or bulk-test the reporting, because it
 * adds noise to a system that always needs to be attended diligently."*
 *
 * ⭐ **This is the test that had to exist for `probePlan` to be worth extracting.** Every
 * rule below is otherwise only a paragraph in a module header, and *where a document claims
 * an absence, that absence needs a test* — an absence nothing exercises is an absence nobody
 * notices disappearing. The obvious alternative, grepping the script's source for the guard,
 * would pass on a guard that had been written and then bypassed.
 *
 * ⚠️ **Note what is NOT asserted here: that the probe files a report.** These tests never
 * reach the network and never write a row. A suite that exercised the probe end to end would
 * be the automatic abuse test the rule forbids, wearing a different hat.
 */
import { describe, expect, it } from "bun:test";
import { isRefusal, probePlan } from "./abuse-probe.ts";

/** The ordinary invocation: a person at a terminal, no CI. */
const ATTENDED = { argv: ["--base", "https://anthers.org"], env: {} as Record<string, string> };

function plan(argv: string[], env: Record<string, string | undefined> = {}, isTty = true) {
	return probePlan(argv, env, isTty);
}

describe("a password may not arrive on the command line", () => {
	for (const flag of ["--admin-password", "--password", "--admin-pass"]) {
		it(`refuses ${flag} rather than ignoring it`, () => {
			// 🚨 Refused, not ignored. Ignoring the flag would leave the secret in the shell
			// history exactly as before while reading as though the problem were solved, and
			// the refusal is the only moment anybody gets told to rotate it.
			const result = plan([...ATTENDED.argv, flag, "hunter2"]);
			expect(isRefusal(result)).toBe(true);
			if (!isRefusal(result)) return;
			expect(result.refuse).toContain("terminal");
			expect(result.refuse.toLowerCase()).toContain("rotate");
		});
	}

	it("refuses before it decides anything else, so a bad flag cannot mask it", () => {
		// The password check runs first on purpose: an invocation carrying both a password
		// and an unknown --path must still be told about the password, because that is the
		// one with a credential in the shell history behind it.
		const result = plan([...ATTENDED.argv, "--path", "nonsense", "--admin-password", "x"]);
		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.refuse).toContain("--admin-password");
	});

	it("still accepts the login, which is not a secret", () => {
		const result = plan([...ATTENDED.argv, "--admin-login", "someone@example.com"]);
		expect(isRefusal(result)).toBe(false);
		if (!isRefusal(result)) expect(result.adminLogin).toBe("someone@example.com");
	});

	it("takes --admin-email as the same field, because it is the obvious thing to type", () => {
		const result = plan([...ATTENDED.argv, "--admin-email", "someone@example.com"]);
		if (!isRefusal(result)) expect(result.adminLogin).toBe("someone@example.com");
	});
});

describe("nobody here, nothing runs", () => {
	it("refuses without a terminal", () => {
		// A cron job, a CI step and a deploy hook all fail this. An abuse report is a request
		// for somebody to stop what they are doing and look, and nothing may make one on a
		// timer.
		const result = plan(ATTENDED.argv, {}, false);
		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.refuse).toContain("unattended");
	});

	it("refuses under CI even with a terminal", () => {
		// 🚨 Checked separately, and this is the case the TTY check alone would miss: CI can
		// allocate a terminal, which would make the guard pass in the one environment it most
		// exists to fail in.
		const result = plan(ATTENDED.argv, { CI: "true" }, true);
		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.refuse).toContain("CI");
	});

	it("runs for a person at a terminal", () => {
		expect(isRefusal(plan(ATTENDED.argv, {}, true))).toBe(false);
	});
});

describe("one report per run", () => {
	it("files the public report by default", () => {
		const result = plan(ATTENDED.argv);
		if (!isRefusal(result)) expect(result.path).toBe("public");
	});

	it("takes the in-app path instead, never as well", () => {
		// ⭐ The type is the enforcement. There is no combination of arguments that produces
		// two reports, because `path` is one value rather than two booleans — two alerts prove
		// nothing the first did not, and each extra one teaches whoever reads that mailbox to
		// skim it.
		const result = plan([...ATTENDED.argv, "--path", "in-app"]);
		if (!isRefusal(result)) expect(result.path).toBe("in-app");
	});

	it("refuses a path it does not recognize rather than falling back to one", () => {
		// Falling back would mean a typo silently files the report the person did not ask
		// for, on a surface where that costs somebody's attention.
		const result = plan([...ATTENDED.argv, "--path", "both"]);
		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.refuse).toContain("both");
	});

	it("has retired the flags that used to accumulate reports", () => {
		// `--fixture` added a second report to the first; `--cleanup` made tidying optional.
		// Neither is read any more, so passing them changes nothing — asserted so that
		// reviving either has to be a deliberate edit here.
		const withOld = plan([...ATTENDED.argv, "--fixture", "--cleanup"]);
		expect(isRefusal(withOld)).toBe(false);
		if (!isRefusal(withOld)) expect(withOld.path).toBe("public");
	});
});

describe("the rest of the plan", () => {
	it("strips trailing slashes off the base, so the URLs it builds are not doubled", () => {
		const result = plan(["--base", "https://anthers.org///"]);
		if (!isRefusal(result)) expect(result.base).toBe("https://anthers.org");
	});

	it("waits long enough for the five-minute retry sweep by default", () => {
		// Anything under 300 can report a false "never escalated", because the cron that
		// retries an unsent alert runs every five minutes.
		const result = plan(ATTENDED.argv);
		if (!isRefusal(result)) expect(result.waitSeconds).toBeGreaterThanOrEqual(300);
	});
});
