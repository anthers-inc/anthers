// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Assert that Stripe can actually reach this app's webhook, and that the secrets production
 * holds are the ones that work.
 *
 * ── Why ────────────────────────────────────────────────────────────────────────────
 *
 * 🚨 Production ran for weeks with **no registered webhook endpoint at all** and a
 * `STRIPE_WEBHOOK_SECRET` that was a `stripe listen` CLI secret copied out of a developer's
 * `.env`. Nothing failed. The route answered, the config looked populated, `spec-diff` was
 * green, and the money paths simply never ran: `payments.ts` is the only writer of
 * `purchases.status = "completed"`, so buyers were charged and got nothing;
 * `syncSubscriptionToAccount` never ran, so Badge stayed Free and directed support never
 * cleared a creator's gates. It surfaced only because someone probed production by hand.
 *
 * `make stripe-webhooks` runs `stripe listen`, which forwards to localhost — so every one of
 * those paths works perfectly in dev and the gauntlet exercises them. The failure existed
 * only where no CLI is running, which is production and nowhere else. That is why this check
 * talks to the live app rather than to a test double.
 *
 * ── What it asserts ────────────────────────────────────────────────────────────────
 *
 *   1. Stripe has an **enabled** endpoint at this app's webhook URL for each scope in use.
 *   2. Those endpoints between them cover **every event the handler branches on** — see the
 *      note on EXPECTED below for why that list is read out of the source.
 *   3. The **deployed** app accepts a payload signed with each secret the vault holds, and
 *      rejects one signed with a secret nobody issued.
 *
 * (3) is the one that cannot be faked: Stripe never returns an endpoint's signing secret
 * after creation, so the only way to know production holds the right one is to sign
 * something and watch it be accepted. The wrong-secret control is not decoration — without
 * it, an endpoint that accepted everything would pass.
 *
 * Usage:  DOCTL_CONTEXT=anthers make webhook-check
 * Needs:  `bws` with read on the Anthers project. Not in `make verify` — it reaches the
 *         network and needs vault access, exactly like `spec-diff`.
 */

import Stripe from "stripe";
import { bwsSecrets } from "./bws";

// Production's secrets, read with the production machine account. The project's *name* lives
// in `bws.ts` now rather than here — it was the literal string "Anthers" until the web-vault
// rename of 2026-08-30 made that name resolve to nothing, and a name written at each call
// site is a name that gets missed at one of them.
const ROLE = "prod" as const;
// Overridable so the check itself can be driven against doctored inputs — a check nobody
// has watched fail is worth about as much as no check, and these two files are where every
// interesting failure enters (a handler branch nothing delivers, a URL Stripe never heard of).
const HANDLER = process.env.WEBHOOK_HANDLER ?? "apps/api/src/routes/payments.ts";
const SPEC = process.env.WEBHOOK_SPEC ?? ".do/app.yaml";
const PATH = "/api/payments/stripe/webhook";

/**
 * The event types the handler actually branches on, read out of the handler.
 *
 * A hand-maintained list here would be a third copy of something that already exists twice
 * (the code, and Stripe's subscription) — and the whole failure being guarded against is two
 * descriptions of production disagreeing without anyone noticing. Parsing the source keeps
 * the check honest when someone adds a branch and forgets to subscribe to it.
 */
function handledEvents(source: string): string[] {
	return [
		...new Set([...source.matchAll(/event\.type === "([a-z_.]+)"/g)].map((m) => m[1] as string)),
	];
}

/** The app's public webhook URL, composed from the PRIMARY domain the spec declares. */
function webhookUrl(spec: string): string {
	const parsed = Bun.YAML.parse(spec) as { domains?: { domain?: string; type?: string }[] };
	const primary = (parsed.domains ?? []).find((d) => d.type === "PRIMARY")?.domain;
	if (!primary) throw new Error(`no PRIMARY domain in ${SPEC}`);
	return `https://${primary}${PATH}`;
}

const problems: string[] = [];
const note = (ok: boolean, message: string) => {
	console.log(`  ${ok ? "✓" : "✗"} ${message}`);
	if (!ok) problems.push(message);
};

const url = webhookUrl(await Bun.file(SPEC).text());
const expected = handledEvents(await Bun.file(HANDLER).text());
console.log(`\n## Webhook check — ${url}\n`);
console.log(`  handler branches on ${expected.length} event types (read from ${HANDLER})\n`);

const secrets = await bwsSecrets(ROLE);
const apiKey = secrets.get("STRIPE_SECRET_KEY");
if (!apiKey) {
	console.error("webhook-check: no STRIPE_SECRET_KEY in the vault.");
	process.exit(2);
}
const stripe = new Stripe(apiKey);

// ── 1 + 2. Registration ──────────────────────────────────────────────────────────────
const endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter(
	(e) => e.url === url,
);
note(endpoints.length > 0, `Stripe has ${endpoints.length} endpoint(s) at this URL`);
for (const e of endpoints) {
	note(e.status === "enabled", `  endpoint ${e.id} is ${e.status}`);
}

const subscribed = new Set(endpoints.flatMap((e) => e.enabled_events ?? []));
const uncovered = expected.filter((t) => !subscribed.has(t) && !subscribed.has("*"));
note(
	uncovered.length === 0,
	uncovered.length === 0
		? "every event the handler branches on is subscribed"
		: `events the handler branches on but nothing delivers: ${uncovered.join(", ")}`,
);

// Extra subscriptions are noise rather than danger — the handler ignores them — but they
// cost delivery attempts and usually mean a copy-pasted event list.
const unhandled = [...subscribed].filter((t) => !expected.includes(t) && t !== "*");
if (unhandled.length)
	console.log(`  · subscribed but not handled (harmless): ${unhandled.join(", ")}`);

// ── 3. The deployed app actually verifies these secrets ──────────────────────────────
const body = JSON.stringify({
	id: "evt_webhook_check",
	object: "event",
	type: "payment_intent.succeeded",
	// An id nothing can match, so the handler updates zero rows however far it gets.
	data: { object: { id: "pi_webhook_check_absent", object: "payment_intent" } },
});

/**
 * Returns the HTTP status, or 0 when the app could not be reached at all.
 *
 * The unreachable case is caught rather than thrown: a DNS failure or a dropped connection
 * is a finding about production, and it should read as one line in this report next to the
 * others — not as an unhandled rejection and a stack trace, which is what it did until a
 * sabotage run pointed the check at a host that does not exist.
 */
async function postSigned(secret: string): Promise<number> {
	const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "stripe-signature": header },
			body,
		});
		return res.status;
	} catch (err) {
		console.log(`    (could not reach ${url}: ${(err as Error).message})`);
		return 0;
	}
}

for (const key of ["STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET"]) {
	const secret = secrets.get(key);
	if (!secret) {
		console.log(`  · ${key} not in the vault — skipped`);
		continue;
	}
	const status = await postSigned(secret);
	note(status === 200, `live app accepts a payload signed with ${key} (got ${status})`);
}

// The control. Without it every line above could pass against an endpoint that accepts
// anything, which is precisely the state this check exists to detect.
const forged = await postSigned(`whsec_${"0".repeat(32)}`);
note(forged === 400, `live app REJECTS a payload signed with an unissued secret (got ${forged})`);

console.log("");
if (problems.length) {
	console.error(`webhook-check: ${problems.length} problem(s).\n`);
	process.exit(1);
}
console.log("webhook-check: Stripe can reach this app and production holds working secrets ✓\n");
