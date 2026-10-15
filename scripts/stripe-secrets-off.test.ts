// SPDX-License-Identifier: Apache-2.0
/**
 * The absence test for the lane invariant: **a test session runs with Stripe unconfigured,
 * whatever a checkout's `.env` holds.**
 *
 * There is no feature here to exercise — the claim is an absence (`paymentsConfigured()`
 * never sees a key on the lane) — so the guard runs the real mechanism: a fresh `bun`
 * subprocess with the three variables planted, first with the preload (the browser lane's
 * exact mechanic) and then without it. The without-run is the can-fail half built in: it
 * prints the same variables through, so the with-run is only green because the strip did
 * the deleting. The other two assertions are drift guards reading the two consumers'
 * sources — the webServer command must keep the preload beside its `--env-file` (dropping
 * the env-file strips the API's legitimate non-secret config; dropping the preload
 * resurrects the hole), and the Makefile must keep naming Stripe's variables at nothing,
 * which is what "`.env` is not a secrets' home" means at its last fill-in site.
 *
 * The values here are marked fixtures in the credential shapes the guard allows
 * (`EXAMPLE`); they only ever cross this file's own spawn env.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SECRET_VARS = [
	"STRIPE_SECRET_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"STRIPE_CONNECT_WEBHOOK_SECRET",
] as const;

// 🚨 Marked fixtures (the credential-shape guard's `EXAMPLE` allowance); never a real key.
const PLANTED: Record<(typeof SECRET_VARS)[number], string> = {
	STRIPE_SECRET_KEY: "sk_test_EXAMPLE_KEY",
	STRIPE_WEBHOOK_SECRET: "whsec_EXAMPLE_KEY",
	STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_EXAMPLE_CONNECT",
};

// Exits 3 when any planted variable is visible, 0 when the process holds none — so the
// leak path answers with the names rather than only a boolean.
const PROBE = `const leaked = ${JSON.stringify(SECRET_VARS)}.filter((n) => process.env[n]);
if (leaked.length) { console.log(leaked.join(" ")); process.exit(3); }`;

const stripPreload = new URL("./stripe-secrets-off.ts", import.meta.url);
const repoRoot = new URL("..", import.meta.url);

describe("the lanes' Stripe strip", () => {
	it("deletes the processor's secrets from a process that loaded them", () => {
		const preloaded = Bun.spawnSync(["bun", `--preload=${stripPreload.pathname}`, "-e", PROBE], {
			cwd: repoRoot.pathname,
			env: { ...process.env, ...PLANTED },
		});
		expect(
			preloaded.exitCode,
			`${stripPreload.pathname} should leave every lane process with no Stripe key ${
				preloaded.exitCode === 3 ? `— leaked: ${preloaded.stdout.toString().trim()}` : ""
			}`,
		).toBe(0);

		// The sibling without the preload: same planted process, keys visible. This is
		// what the subprocess proves the assert can fail for — Bun itself never strips.
		const bare = Bun.spawnSync(["bun", "-e", PROBE], {
			cwd: repoRoot.pathname,
			env: { ...process.env, ...PLANTED },
		});
		expect(bare.exitCode, "a bun process without the preload should SEE the planted keys").toBe(3);
	});

	it("keeps the browser lane's API webServer preloading the strip beside its --env-file", async () => {
		const config = (await import("../apps/web/playwright.config.ts")).default;
		const servers: readonly { command: string }[] = Array.isArray(config.webServer)
			? (config.webServer as { command: string }[])
			: [config.webServer as { command: string }];
		const api = servers.find((server) => server.command.includes("src/server.ts"));
		expect(api, "the API webServer entry moved or vanished from the config").toBeDefined();
		expect(api?.command).toContain("--env-file=../../.env");
		expect(
			api?.command,
			"the API webServer command no longer strips the processor's secrets — restore --preload=…/stripe-secrets-off.ts",
		).toContain(`--preload=../../scripts/stripe-secrets-off.ts`);
	});

	it("names Stripe's variables nowhere in the Makefile", () => {
		const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
		const hits = makefile.split("\n").filter((line) => line.includes("STRIPE"));
		expect(
			hits,
			"the Makefile names a STRIPE* variable, which was how .env stayed a secrets' home — a new legitimate consumer goes through scripts/bws.ts",
		).toEqual([]);
	});
});
