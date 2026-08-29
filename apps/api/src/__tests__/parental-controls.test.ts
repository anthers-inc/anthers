// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parental controls, end to end — and the pin, which is the whole security model.
 *
 * 🚨 **The threat here is the account holder, not a stranger.** A child holds the session by
 * definition, so every control is one HTTP request away from being lifted by the person it
 * restricts unless the server checks the pin itself. That makes "the panel is hidden in the
 * browser" worth nothing, and it is the shape of test this file is mostly made of: take the
 * session, skip the UI, and try to turn the lock off.
 *
 * ⚠️ **Three enforcement points, none of them redundant.** The resolver refuses a blocked
 * creator or medium; a SQL condition keeps them out of listings, because a shelf of cards a
 * child cannot click is an advertisement rather than a protection; and a delivery gate refuses
 * once a household's time is spent. Sabotage any one and a different promise breaks.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, attentionEvents, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function send(path: string, method: string, cookie: string, body: unknown) {
	return req(path, {
		method,
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	});
}

async function signUp(username: string) {
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

const OPEN = { seedAccess: [{ threshold: 0, allow: true, price: "0" }] };
const PIN = "4821";

const id = crypto.randomUUID().slice(0, 8);
const childName = `pc_child_${id}`;
const creatorName = `pc_creator_${id}`;
const otherCreatorName = `pc_other_${id}`;

describe("Parental controls", () => {
	let child: string;
	let creatorCookie: string;
	let childId: number;
	let creatorId: number;
	let otherCreatorId: number;
	let videoId: number;
	let textId: number;
	let otherTextId: number;

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${childName}, ${creatorName}, ${otherCreatorName})`,
		);
		child = await signUp(childName);
		creatorCookie = await signUp(creatorName);
		await signUp(otherCreatorName);
		const rows = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(sql`username IN (${childName}, ${creatorName}, ${otherCreatorName})`);
		childId = rows.find((r) => r.username === childName)!.id;
		creatorId = rows.find((r) => r.username === creatorName)!.id;
		otherCreatorId = rows.find((r) => r.username === otherCreatorName)!.id;

		videoId = (
			await insertWork({
				creatorId,
				type: "video",
				title: "A video",
				streamEnabled: true,
				...OPEN,
			})
		).id;
		textId = (
			await insertWork({
				creatorId,
				type: "text",
				title: "An essay",
				bodyHtml: "<p>the-prose</p>",
				streamEnabled: true,
				...OPEN,
			})
		).id;
		otherTextId = (
			await insertWork({
				creatorId: otherCreatorId,
				type: "text",
				title: "Another essay",
				bodyHtml: "<p>other-prose</p>",
				streamEnabled: true,
				...OPEN,
			})
		).id;

		const set = await send("/api/accounts/me/parental-controls/pin", "PUT", child, { pin: PIN });
		expect(set.status).toBe(200);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${childName}, ${creatorName}, ${otherCreatorName})`,
		);
	});

	/** Put the account back to "a pin and nothing else" between tests. */
	async function reset() {
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			lockMaturity: false,
			creators: { defaultAllow: true, rules: [] },
			types: { defaultAllow: true, rules: [] },
			limits: { daily: null, weekly: null, monthly: null },
			languageFilter: false,
		});
		await db.delete(attentionEvents).where(eq(attentionEvents.userId, childId));
		// The support account too, because the Adult tests below seed one and every column
		// that decides whether the rung is reachable lives on it.
		await db.delete(accounts).where(eq(accounts.userId, childId));
	}

	/**
	 * Put the account in the state the borrowed card leaves behind: adulthood already
	 * verified, and opted out.
	 *
	 * 🚨 **This is the exploit path, and it needs no Stripe.** `enableAdultAccess` skips the
	 * card check entirely when `adultVerifiedAt` is already set — verification is once, at
	 * enablement — so an account that cleared the funding check before a pin was set can
	 * re-open the rung with a bare POST. That is also the likeliest account to have been
	 * holding somebody else's card, which is why the lock sits above the shortcut.
	 *
	 * ⚠️ **`display: null` is the case that matters and it is the ordinary one.** The Adult
	 * column is empty until somebody sets it and reads back as `hide` from the default, so
	 * opting in writes a real `blur` over it — the escalation. A reader who typed `hide`
	 * themselves keeps it, which is why the two are seeded separately.
	 */
	async function alreadyVerified(display: string | null) {
		const seeded = {
			adultOptIn: false,
			adultVerifiedAt: new Date(),
			adultVerifiedMethod: "card_funding",
			adultDisplay: display,
		};
		await db
			.insert(accounts)
			.values({ userId: childId, ...seeded })
			.onConflictDoUpdate({ target: accounts.userId, set: seeded });
	}

	/** Turn the maturity lock on, with the pin, leaving everything else alone. */
	function lock(on: boolean) {
		return send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			lockMaturity: on,
		});
	}

	// ── The pin ───────────────────────────────────────────────────────────────

	it("🚨 refuses every write without the pin, from the account's own session", async () => {
		// The threat model in one test. The child holds the session; that must not be enough.
		for (const [path, method, body] of [
			["/api/accounts/me/parental-controls", "PATCH", { pin: "0000", lockMaturity: false }],
			["/api/accounts/me/parental-controls", "DELETE", { pin: "0000" }],
			["/api/accounts/me/parental-controls/pin", "PUT", { pin: "9999", currentPin: "0000" }],
		] as const) {
			const res = await send(path, method, child, body);
			expect(res.status, `${method} ${path}`).toBe(403);
			expect((await res.json()).code).toBe("wrong_pin");
		}
	});

	it("refuses a pin that isn't 4–8 digits", async () => {
		const fresh = await signUp(`pc_pin_${id}`);
		for (const pin of ["123", "123456789", "abcd", "12 34", ""]) {
			const res = await send("/api/accounts/me/parental-controls/pin", "PUT", fresh, { pin });
			expect(res.status, pin).toBe(400);
		}
	});

	it("lets the account holder READ what is set, without saying what the pin is", async () => {
		// A child seeing their own restrictions is not a leak — being told what the rules are
		// is the difference between a boundary and a bug. The pin itself never leaves.
		const res = await req("/api/accounts/me/parental-controls", { headers: { Cookie: child } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.enabled).toBe(true);
		expect(JSON.stringify(body)).not.toContain(PIN);
		expect(body).not.toHaveProperty("pinHash");
	});

	// ── The maturity lock ─────────────────────────────────────────────────────

	it("🚨 locks the content-rating settings against the account's own session", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			lockMaturity: true,
		});

		const res = await send("/api/accounts/me/content-preferences", "PATCH", child, {
			mature: "show",
		});
		// Refused, not silently ignored: a setting that appears to save and does not is worse
		// than one that says no.
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("parental_locked");

		const prefs = await (
			await req("/api/accounts/me/content-preferences", { headers: { Cookie: child } })
		).json();
		expect(prefs.mature).not.toBe("show");
		await reset();
	});

	it("leaves the settings alone when the lock is off", async () => {
		await reset();
		const res = await send("/api/accounts/me/content-preferences", "PATCH", child, {
			mature: "show",
		});
		expect(res.status).toBe(200);
		await reset();
	});

	it("🚨 refuses to OPEN the Adult rung from inside the lock, verified card and all", async () => {
		// The defect this file was missing until 2026-08-29. `lockMaturity` was enforced at
		// `PATCH /me/content-preferences` alone, but reaching Adult work is governed by
		// `adultOptIn` and `adultVerifiedAt`, which a different route writes — so the pin a
		// parent was told closes the borrowed-card gap closed nothing at all.
		await reset();
		await alreadyVerified(null);
		await lock(true);

		const res = await send("/api/accounts/me/adult-access", "POST", child, {});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("parental_locked");

		const access = await (
			await req("/api/accounts/me/adult-access", { headers: { Cookie: child } })
		).json();
		expect(access.optIn).toBe(false);
		expect(access.canReach).toBe(false);

		// ...and the display preference the write would have trampled is still `hide`.
		// `enableAdultAccess` writes a real `blur` over the empty column that reads back as
		// the default, so the same request that opened the rung also made the work *listed*
		// — the one preference the lock is named for.
		const prefs = await (
			await req("/api/accounts/me/content-preferences", { headers: { Cookie: child } })
		).json();
		expect(prefs.adult).toBe("hide");

		// The card check is the same door one step earlier, and it is shut too — nobody is
		// walked through attaching a card to an account that may not use it.
		const setup = await send("/api/accounts/me/adult-access/setup", "POST", child, {});
		expect(setup.status).toBe(403);
		expect((await setup.json()).code).toBe("parental_locked");

		await reset();
	});

	it("⭐ opens it with the lock off, which is what proves the lock is doing the work", async () => {
		// Without this the test above passes for any reason a request might fail — a missing
		// Stripe key on the runner would do it. The same request, same fixture, one switch.
		await reset();
		await alreadyVerified(null);

		const res = await send("/api/accounts/me/adult-access", "POST", child, {});
		expect(res.status).toBe(200);
		expect((await res.json()).canReach).toBe(true);

		const prefs = await (
			await req("/api/accounts/me/content-preferences", { headers: { Cookie: child } })
		).json();
		expect(prefs.adult).toBe("blur");
		await reset();
	});

	it("⭐ still lets the account opt back OUT under the lock, because that only tightens", async () => {
		// The asymmetry is deliberate. A lock that stopped somebody making their own account
		// stricter would be protecting nobody, so only the two routes that open the rung
		// answer to it.
		await reset();
		await alreadyVerified("blur");
		await db.update(accounts).set({ adultOptIn: true }).where(eq(accounts.userId, childId));
		await lock(true);

		const res = await send("/api/accounts/me/adult-access", "DELETE", child, {});
		expect(res.status).toBe(200);
		expect((await res.json()).canReach).toBe(false);

		// And it cannot be undone from inside the lock, which is the half that matters.
		const back = await send("/api/accounts/me/adult-access", "POST", child, {});
		expect(back.status).toBe(403);
		await reset();
	});

	// ── Creators and media types ──────────────────────────────────────────────

	it("🚨 refuses a blocked creator's Work, and hides it from listings", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			creators: {
				defaultAllow: true,
				rules: [{ key: String(creatorId), allow: false, dailySeconds: null }],
			},
		});

		const { work } = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(work.access.canAccess).toBe(false);
		expect(work.access.reason).toBe("blocked_creator");
		expect(work.bodyHtml).toBe("");

		// ...and it is not on the shelf either. Both are needed: the resolver stops it being
		// opened, this stops it being advertised.
		const catalog = await (
			await req(`/api/content/catalog/${creatorName}`, { headers: { Cookie: child } })
		).json();
		expect(catalog.works.map((w: { id: number }) => w.id)).not.toContain(textId);

		// An unblocked creator is untouched.
		const other = await (
			await req(`/api/content/works/${otherTextId}`, { headers: { Cookie: child } })
		).json();
		expect(other.work.access.canAccess).toBe(true);
		await reset();
	});

	it("🚨 an allowlist admits only what is on it", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			creators: {
				defaultAllow: false,
				rules: [{ key: String(otherCreatorId), allow: true, dailySeconds: null }],
			},
		});

		const blocked = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(blocked.work.access.reason).toBe("blocked_creator");
		const allowed = await (
			await req(`/api/content/works/${otherTextId}`, { headers: { Cookie: child } })
		).json();
		expect(allowed.work.access.canAccess).toBe(true);
		await reset();
	});

	it("blocks a medium without touching the rest", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			types: { defaultAllow: true, rules: [{ key: "video", allow: false, dailySeconds: null }] },
		});

		const video = await (
			await req(`/api/content/works/${videoId}`, { headers: { Cookie: child } })
		).json();
		expect(video.work.access.reason).toBe("blocked_type");
		const text = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(text.work.access.canAccess).toBe(true);
		await reset();
	});

	it("⭐ never blocks a creator from their own work", async () => {
		// A young creator locked out of the thing they made would be a strange way to protect
		// them, and it would make their own Work un-editable.
		await send("/api/accounts/me/parental-controls/pin", "PUT", creatorCookie, { pin: PIN });
		await send("/api/accounts/me/parental-controls", "PATCH", creatorCookie, {
			pin: PIN,
			creators: {
				defaultAllow: false,
				rules: [{ key: String(otherCreatorId), allow: true, dailySeconds: null }],
			},
		});
		const res = await req(`/api/content/works/${textId}`, { headers: { Cookie: creatorCookie } });
		const { work } = await res.json();
		// The owner shape, which carries no verdict at all — they reached it.
		expect(work.bodyHtml).toBe("<p>the-prose</p>");
		await send("/api/accounts/me/parental-controls", "DELETE", creatorCookie, { pin: PIN });
	});

	// ── Time limits ───────────────────────────────────────────────────────────

	it("🚨 withholds the deliverable once the day's time is spent", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			limits: { daily: 1800, weekly: null, monthly: null },
		});

		const before = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(before.work.bodyHtml).toBe("<p>the-prose</p>");

		await db.insert(attentionEvents).values({
			userId: childId,
			creatorId,
			workId: textId,
			eventType: "read",
			durationSeconds: 1800,
			publicAccess: true,
		});

		const after = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(after.work.bodyHtml).toBe("");
		// ⚠️ The Work still reports itself reachable and free. What ran out belongs to the
		// account, exactly as with the Public Access allowance — a Work that described itself
		// as gated by somebody's household would be describing the wrong thing.
		expect(after.work.access.canAccess).toBe(true);
		expect(after.work.access.isFree).toBe(true);
		await reset();
	});

	it("🚨 counts time against work the account PAID for, not only the commons", async () => {
		// The Public Access meter asks what the commons owes a viewer; this asks how long
		// somebody has been consuming. Filtering on `public_access` here would let a whole
		// household limit be bypassed by anything that was bought.
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			limits: { daily: 600, weekly: null, monthly: null },
		});
		await db.insert(attentionEvents).values({
			userId: childId,
			creatorId,
			workId: textId,
			eventType: "read",
			durationSeconds: 600,
			// Not the commons — gated work they cleared, or bought.
			publicAccess: false,
		});

		const { work } = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(work.bodyHtml).toBe("");
		await reset();
	});

	it("refuses the delivery routes with a reason, not a price", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			limits: { daily: 60, weekly: null, monthly: null },
		});
		await db.insert(attentionEvents).values({
			userId: childId,
			creatorId,
			workId: videoId,
			eventType: "watch",
			durationSeconds: 60,
			publicAccess: true,
		});

		const res = await req(`/api/content/works/${videoId}/hls/master.m3u8`, {
			headers: { Cookie: child },
			redirect: "manual",
		});
		// 403, never 402. A spent allowance is "you may, and here is how"; a time limit has no
		// price, and offering one would be the platform selling a way around somebody's parent.
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("parental_time_limit");
		await reset();
	});

	it("a per-creator cap bites before the whole-app one", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			limits: { daily: 7200, weekly: null, monthly: null },
			creators: {
				defaultAllow: true,
				rules: [{ key: String(creatorId), allow: true, dailySeconds: 600 }],
			},
		});
		await db.insert(attentionEvents).values({
			userId: childId,
			creatorId,
			workId: textId,
			eventType: "read",
			durationSeconds: 600,
			publicAccess: true,
		});

		const capped = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(capped.work.bodyHtml).toBe("");
		// The whole-app budget is nowhere near spent, so another creator is still reachable.
		const other = await (
			await req(`/api/content/works/${otherTextId}`, { headers: { Cookie: child } })
		).json();
		expect(other.work.bodyHtml).toBe("<p>other-prose</p>");
		await reset();
	});

	// ── Turning it off ────────────────────────────────────────────────────────

	it("clears everything with the pin, and the account is unrestricted again", async () => {
		await reset();
		await send("/api/accounts/me/parental-controls", "PATCH", child, {
			pin: PIN,
			types: { defaultAllow: false, rules: [] },
		});
		expect(
			(await (await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })).json())
				.work.access.reason,
		).toBe("blocked_type");

		const gone = await send("/api/accounts/me/parental-controls", "DELETE", child, { pin: PIN });
		expect(gone.status).toBe(200);
		expect((await gone.json()).enabled).toBe(false);

		const { work } = await (
			await req(`/api/content/works/${textId}`, { headers: { Cookie: child } })
		).json();
		expect(work.access.canAccess).toBe(true);

		// And the pin is genuinely gone rather than remembered — a row of falses would leave
		// the account holding a pin nobody set.
		expect(
			(await send("/api/accounts/me/parental-controls", "PATCH", child, { pin: PIN })).status,
		).toBe(403);
		await send("/api/accounts/me/parental-controls/pin", "PUT", child, { pin: PIN });
	});
});
