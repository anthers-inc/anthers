// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A creator cannot set an amount the payment rail will refuse.
 *
 * 🚨 **Stripe will not process a charge below $0.50, and until 2026-08-29 nothing stopped a
 * creator pricing a Work at $0.25.** We accepted it, published it, and let a buyer click Buy;
 * the failure surfaced as a PaymentIntent error at checkout. So the creator never learned
 * their price was unbuyable and the buyer is the one who found out. Parker's framing: a
 * single-item purchase is its own invoice, and the floor was always on the invoice — the
 * purchase path simply never applied it.
 *
 * ⚠️ **The rule is "$0 or at least $0.50, and nothing in between", never a flat minimum.**
 * $0 with Allow checked is exactly what Public Access is, so the free cases are asserted
 * beside the refused ones in every block below — a suite that only checked the refusals would
 * pass against an implementation that had priced the entire commons.
 *
 * ⭐ **`POST /seeds` stays unfloored and has its own test.** It allocates an already-charged
 * balance, creates no Stripe charge, and a blanket sweep would have floored it wrongly.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { STRIPE_MIN_CHARGE } from "@anthers/shared/constants";
import { like } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = Date.now().toString(36);

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

let auth: Record<string, string>;
let workId = 0;

/** Try to write this access table onto the fixture Work. Returns the status. */
async function setPrice(price: string): Promise<number> {
	const res = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: auth,
		body: JSON.stringify({ seedAccess: [{ threshold: 0, allow: true, price }] }),
	});
	return res.status;
}

/** Try to write this gate threshold. Returns the status. */
async function setBadge(threshold: string): Promise<number> {
	const res = await req("/api/subscriptions/gates", {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ threshold, label: `Level ${threshold}` }),
	});
	if (res.status === 201) {
		const { gate } = (await res.json()) as { gate: { id: number } };
		await req(`/api/subscriptions/gates/${gate.id}`, { method: "DELETE", headers: auth });
	}
	return res.status;
}

describe("Stripe's minimum charge floors what a creator can set", () => {
	beforeAll(async () => {
		const cookie = await signUp(`cf_${RUN}`);
		auth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie };
		const created = await req("/api/content/works", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ type: "audio", title: "Floor fixture", maturity: "general" }),
		});
		expect(created.status).toBe(201);
		workId = (await created.json()).work.id as number;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// The Work and the gates cascade from the account; nothing here outlives it.
		await db.delete(users).where(like(users.email, `cf_${RUN}%`));
	});

	// ── Work prices ───────────────────────────────────────────────────────────

	it("🚨 refuses a Work price in the gap between free and the floor", async () => {
		for (const price of ["0.25", "0.01", "0.49"]) {
			expect(await setPrice(price), `$${price}`).toBe(400);
		}
	});

	it("🚨 still accepts a FREE Work, which a flat minimum would have priced", async () => {
		// The assertion the whole shape of the rule exists for. Public Access is $0 with
		// Allow checked, so `min(0.50)` would have made every ungated Work invalid.
		expect(await setPrice("0")).toBe(200);
		expect(await setPrice("0.00")).toBe(200);
	});

	it("accepts the floor itself and anything above it", async () => {
		expect(await setPrice(STRIPE_MIN_CHARGE.toFixed(2))).toBe(200);
		expect(await setPrice("5.00")).toBe(200);
	});

	// ── Badge levels ──────────────────────────────────────────────────────────

	it("🚨 refuses a Badge level nobody could fund on its own", async () => {
		// Settled by Parker on 2026-08-29. A Badge threshold is not itself a charge — it
		// rides on the monthly subscription that batches every destination — but a supporter
		// who wants only this one Badge is refused at checkout by the invoice minimum, and
		// `directed[].amount` already floors a single directed amount at the same figure. A
		// level a creator can set and some supporters cannot fund fails in the buyer's
		// checkout instead of in the creator's editor, which is the wrong end.
		for (const threshold of ["0.25", "0.49"]) {
			expect(await setBadge(threshold), `$${threshold}`).toBe(400);
		}
	});

	it("accepts a Badge level at the floor and above, including a non-round one", async () => {
		// The retirement of the $3 unit is not being undone: $0.75 and $9.50 are exactly the
		// kind of level a creator should be able to set, and they still can.
		for (const threshold of [STRIPE_MIN_CHARGE.toFixed(2), "0.75", "9.50", "15"]) {
			expect(await setBadge(threshold), `$${threshold}`).toBe(201);
		}
	});

	// ── What must stay unfloored ──────────────────────────────────────────────

	it("⭐ leaves the directed-support allocation alone, because it charges nothing", async () => {
		// `POST /seeds` allocates a balance already paid for, so no Stripe charge is created
		// and the floor has nothing to say about it. A blanket sweep over "every amount a
		// user types" would have floored this one wrongly — and zero, which is how somebody
		// stops directing support at a creator, would have been the first casualty.
		const res = await req("/api/subscriptions/seeds", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ creatorId: 0, amount: "0" }),
		});
		// Whatever it answers about the unknown creator, it must not be a validation
		// rejection of the amount itself.
		expect(res.status).not.toBe(400);
	});
});
