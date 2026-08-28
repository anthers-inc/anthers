// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The content rating: declared by a creator, corrected by an operator, appealed by the
 * creator.
 *
 * 🚨 **The appeal half is not a nicety and the tests for it are not optional.** Anthers'
 * Adult rung is payment-gated, so an over-cautious call does not merely add a
 * warning to a work — it puts it behind a paywall, and for a queer coming-of-age story
 * wrongly flagged that is exactly the harm the category exists to prevent, produced by the
 * mechanism meant to prevent it (wiki 40.09). A suite that covered only the correction would
 * be green over the half that can do damage.
 *
 * ⚠️ **The lock is asymmetric, and both directions are asserted.** A creator may raise an
 * operator's rating at any time and may not lower it. An implementation that locked the
 * field outright would pass a test that only tried to lower it, and would have taken a
 * creator's ability to be more careful about their own work away from them.
 *
 * ⭐ **What a viewer is NOT told is asserted too.** The rating and its notes travel with the
 * public blurb — a warning that appears only once you have the thing is not a warning — but
 * `maturitySource` does not, because a viewer able to read it could tell a corrected Work
 * from a self-declared one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { moderationActions, workRatingAppeals, works } from "@anthers/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { purgeFixtureAccounts } from "./cleanup.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `rate_${id}`;
const operatorName = `rateop_${id}`;
const strangerName = `rateoth_${id}`;

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

describe("content ratings", () => {
	let creator: string;
	let operator: string;
	let stranger: string;
	const created: number[] = [];

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${creatorName}, ${operatorName}, ${strangerName})`,
		);
		creator = await signUp(creatorName);
		operator = await signUp(operatorName);
		stranger = await signUp(strangerName);
		await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${operatorName}`);
	}, DB_SETUP_TIMEOUT);

	// In `afterAll` so it runs on a bail as well as a pass. Appeals cascade with the Work
	// and the moderation actions do not — the subject is polymorphic and carries no key —
	// so those go by hand.
	afterAll(async () => {
		if (created.length > 0) {
			await db
				.delete(moderationActions)
				.where(
					and(
						eq(moderationActions.subjectType, "work"),
						inArray(moderationActions.subjectId, created),
					),
				);
			await db.delete(works).where(inArray(works.id, created));
		}
		await purgeFixtureAccounts([creatorName, operatorName, strangerName]);
	});

	/** A private text Work — nothing here needs media, and media needs pg-boss. */
	async function makeWork(body: Record<string, unknown> = {}): Promise<number> {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator },
			body: JSON.stringify({ type: "text", title: `Rating fixture ${id}`, ...body }),
		});
		expect(res.status).toBe(201);
		const { work } = await res.json();
		created.push(work.id);
		return work.id;
	}

	function patch(workId: number, body: Record<string, unknown>, cookie = creator) {
		return req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify(body),
		});
	}

	function correct(workId: number, maturity: string, notes?: string[]) {
		return req("/api/admin/works/rating", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: operator },
			body: JSON.stringify({ workId, maturity, notes, note: "operator call" }),
		});
	}

	async function reload(workId: number) {
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		return row;
	}

	describe("a Work is born unrated", () => {
		it("carries `unrated` and no source when nobody has said", async () => {
			const workId = await makeWork();
			const row = await reload(workId);
			expect(row.maturity).toBe("unrated");
			// Null rather than "creator": nobody declared anything, and recording a source
			// would be claiming somebody did.
			expect(row.maturitySource).toBeNull();
			expect(row.maturityNotes).toEqual([]);
		});

		it("records the creator's own declaration when they make one at create", async () => {
			const workId = await makeWork({ maturity: "mature", maturityNotes: ["violence"] });
			const row = await reload(workId);
			expect(row.maturity).toBe("mature");
			expect(row.maturitySource).toBe("creator");
			expect(row.maturityNotes).toEqual(["violence"]);
		});

		it("drops a note it cannot label rather than storing a code nobody can read", async () => {
			const workId = await makeWork({
				maturity: "general",
				maturityNotes: ["violence", "made-up-note"],
			});
			expect((await reload(workId)).maturityNotes).toEqual(["violence"]);
		});
	});

	describe("release waits for a rating", () => {
		it("refuses to release an unrated Work", async () => {
			const workId = await makeWork();
			const res = await patch(workId, { visibility: "released" });
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("maturity_undeclared");
			expect((await reload(workId)).visibility).toBe("private");
		});

		it("releases once the rating is declared", async () => {
			const workId = await makeWork();
			expect((await patch(workId, { maturity: "general" })).status).toBe(200);
			expect((await patch(workId, { visibility: "released" })).status).toBe(200);
		});

		it("accepts the rating and the release in one request", async () => {
			// The ordinary flow out of the editor, which sends the whole form. Refusing it
			// would mean two round trips to do one thing.
			const workId = await makeWork();
			const res = await patch(workId, { maturity: "mature", visibility: "released" });
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.visibility).toBe("released");
			expect(row.maturity).toBe("mature");
		});

		it("releases a Work its creator rated Adult, now that the rung is open", async () => {
			// ⚠️ **This assertion was the opposite until the rung opened**, and the flip was
			// the point rather than a fixup: Adult went onto `ACCEPTED_MATURITY_RATINGS`
			// only once every fence it needs was real. What the rating then costs the Work
			// — paid, never Public Access, no Time Pool, invisible unless opted in — is
			// `adult-enforcement.test.ts`'s subject rather than the release gate's.
			//
			// The Work must be gated to be released Adult, so it carries a Badge rung. A
			// free one is refused by `adult_must_be_paid`, which that suite covers.
			const workId = await makeWork({
				seedAccess: [
					{ threshold: 0, allow: false, price: "0" },
					{ threshold: 3, allow: true, price: "0" },
				],
			});
			const res = await patch(workId, { maturity: "adult", visibility: "released" });
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.visibility).toBe("released");
			expect(row.maturity).toBe("adult");
			// The creator's own declaration, so nothing is locked — an operator has not
			// touched it, and the second-decision-maker rule is about corrections.
			expect(row.maturitySource).toBe("creator");
		});

		it("keeps the rating when a release is refused for any other reason", async () => {
			// ⭐ The ordering the closed-rung work established, and it outlives the rung
			// being closed. A creator sending the whole form — a rating and a release
			// together — must not lose the declaration when the release is refused, because
			// the cheapest way out of a refusal that ate the answer is to pick a lower rung
			// and have it work. That is the under-declaration pressure wiki 40.13 exists to
			// remove, produced by the gate meant to enforce it.
			//
			// The refusal used here is the free-Adult rule, which is the one that can be
			// reached without media fixtures.
			const workId = await makeWork({ seedAccess: [{ threshold: 0, allow: true, price: "0" }] });
			const res = await patch(workId, { maturity: "adult", visibility: "released" });
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("adult_must_be_paid");

			const row = await reload(workId);
			expect(row.visibility).toBe("private");
			// The declaration survived the refusal.
			expect(row.maturity).toBe("adult");
			expect(row.maturitySource).toBe("creator");
		});

		it("tells a closed rung apart from an unanswered question", async () => {
			// ⚠️ The ordering that makes the two messages honest. `unrated` is not on the
			// accepted list either, so a gate that asked about acceptance first would tell a
			// creator who simply has not answered that Anthers is not taking their kind of
			// work — false, and unfixable, where the real problem is one click.
			const workId = await makeWork();
			const res = await patch(workId, { visibility: "released" });
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("maturity_undeclared");
		});
	});

	describe("an operator's correction", () => {
		it("sets the rating, marks it theirs, and writes the log an appeal will read", async () => {
			const workId = await makeWork({ maturity: "general" });
			const res = await correct(workId, "mature", ["sexual-themes"]);
			expect(res.status).toBe(200);

			const row = await reload(workId);
			expect(row.maturity).toBe("mature");
			expect(row.maturitySource).toBe("operator");
			expect(row.maturityNotes).toEqual(["sexual-themes"]);

			const log = await db
				.select()
				.from(moderationActions)
				.where(
					and(eq(moderationActions.subjectType, "work"), eq(moderationActions.subjectId, workId)),
				);
			expect(log).toHaveLength(1);
			// `reclassify` rather than a reused `hide`/`restore`: nothing became more or
			// less reachable, and recording it as either would make the log lie.
			expect(log[0]!.action).toBe("reclassify");
		});

		it("is not reachable by an ordinary account, and 404s rather than 403s", async () => {
			const workId = await makeWork({ maturity: "general" });
			const res = await req("/api/admin/works/rating", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: stranger },
				body: JSON.stringify({ workId, maturity: "mature" }),
			});
			expect(res.status).toBe(404);
			expect((await reload(workId)).maturity).toBe("general");
		});

		it("cannot put a Work back to unrated", async () => {
			// That would be un-releasing it by a side door: the release gate refuses an
			// unrated Work, so one already out would be in a state no creator path produces.
			const workId = await makeWork({ maturity: "general" });
			const res = await req("/api/admin/works/rating", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: operator },
				body: JSON.stringify({ workId, maturity: "unrated" }),
			});
			expect(res.status).toBe(400);
		});

		it("cannot move a Work to Adult, because one operator is not enough", async () => {
			// 🚨 The burden-of-proof rule from wiki 40.13, and the asymmetry is the whole
			// of it: Adult costs a creator the commons, every Time Pool dollar and their
			// discoverability at once, so moving somebody else's Work there is the
			// adult-content working group's call and that body does not exist. The creator
			// may still declare Adult about their own work whenever they like.
			const workId = await makeWork({ maturity: "general" });
			const res = await correct(workId, "adult");
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("rating_needs_working_group");
			// Refused rather than partly applied: no rating change, and no log entry
			// claiming a call nobody was allowed to make.
			const row = await reload(workId);
			expect(row.maturity).toBe("general");
			expect(row.maturitySource).toBe("creator");
			const log = await db
				.select()
				.from(moderationActions)
				.where(
					and(eq(moderationActions.subjectType, "work"), eq(moderationActions.subjectId, workId)),
				);
			expect(log).toHaveLength(0);
		});
	});

	describe("the lock, in both directions", () => {
		it("refuses to let the creator lower it, and says where the appeal is", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");

			const res = await patch(workId, { maturity: "general" });
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.code).toBe("maturity_locked");
			expect(body.error).toContain("appeal");
			expect((await reload(workId)).maturity).toBe("mature");
		});

		it("lets the creator raise an operator's Mature to Adult", async () => {
			// The rung an operator may not move a Work into is one its creator may always
			// choose. This is the case the caution ORDER exists for: a fourth value added
			// above the others had to leave "raise yes, lower no" true without anybody
			// rewriting the rule, and a pair of hardcoded cases would have refused this.
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");

			expect((await patch(workId, { maturity: "adult" })).status).toBe(200);
			const row = await reload(workId);
			expect(row.maturity).toBe("adult");
			// Raising past a correction is still the creator's own declaration, so the
			// rating comes back to them — and with it the ability to return to the
			// operator's value.
			expect(row.maturitySource).toBe("creator");
		});

		it("lets the creator raise it, and hands the rating back to them", async () => {
			// 🚨 The direction a blanket lock would have broken. Being more cautious about
			// your own work is the creator's business; the harm is only ever downward.
			const workId = await makeWork({ maturity: "mature" });
			await correct(workId, "general");

			const res = await patch(workId, { maturity: "mature" });
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.maturity).toBe("mature");
			expect(row.maturitySource).toBe("creator");
		});

		it("lets a PATCH carrying the unchanged rating through", async () => {
			// The editor sends the whole form on every save, so a save that touches the
			// title must not be refused because it also restated the rating.
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const res = await patch(workId, { maturity: "mature", title: "Renamed" });
			expect(res.status).toBe(200);
			expect((await reload(workId)).title).toBe("Renamed");
		});

		it("never locks the content notes", async () => {
			// Notes carry no access consequence, so there is nothing for a lock to protect —
			// and locking them would take a creator's own warnings to their own readers out
			// of their hands.
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature", ["violence"]);
			const res = await patch(workId, { maturityNotes: ["horror"] });
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.maturityNotes).toEqual(["horror"]);
			// And the lock itself is untouched by a notes-only edit.
			expect(row.maturitySource).toBe("operator");
		});
	});

	describe("the appeal", () => {
		function appeal(workId: number, body: Record<string, unknown>, cookie = creator) {
			return req(`/api/content/works/${workId}/rating-appeals`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
				body: JSON.stringify(body),
			});
		}

		it("refuses one on a rating the creator set themselves, and points at the editor", async () => {
			// Not pedantry: a creator whose rating is their own needs the edit field, not a
			// queue that waits on a person.
			const workId = await makeWork({ maturity: "mature" });
			const res = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("not_locked");
		});

		it("is filed against an operator's correction", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const res = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			expect(res.status).toBe(201);
			const { appeal: filed } = await res.json();
			expect(filed.status).toBe("open");
			// Recorded so a granted appeal can be read years later without re-deriving what
			// the rating was at the time.
			expect(filed.correctedMaturity).toBe("mature");
		});

		it("refuses a second open appeal on the same Work", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const first = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			expect(first.status).toBe(201);
			const second = await appeal(workId, {
				requestedMaturity: "general",
				statement: "Saying the same thing again in a second row in the queue.",
			});
			expect(second.status).toBe(409);
			expect((await second.json()).code).toBe("already_open");
		});

		it("refuses an empty argument", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			expect((await appeal(workId, { requestedMaturity: "general", statement: "" })).status).toBe(
				400,
			);
		});

		it("is not filable by anyone but the Work's creator", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const res = await appeal(
				workId,
				{
					requestedMaturity: "general",
					statement: "Somebody else's work, and not my argument to make.",
				},
				stranger,
			);
			expect(res.status).toBe(404);
		});

		it("applies the rating and lifts the lock when granted", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const filed = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			const { appeal: row } = await filed.json();

			const res = await req("/api/admin/rating-appeals/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: operator },
				body: JSON.stringify({ appealId: row.id, outcome: "granted", note: "You're right." }),
			});
			expect(res.status).toBe(200);

			const work = await reload(workId);
			expect(work.maturity).toBe("general");
			// Conceding the point and keeping the restriction would be neither.
			expect(work.maturitySource).toBe("creator");
		});

		it("leaves the rating alone when upheld, and keeps the answer", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const filed = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			const { appeal: row } = await filed.json();

			const res = await req("/api/admin/rating-appeals/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: operator },
				body: JSON.stringify({
					appealId: row.id,
					outcome: "upheld",
					note: "The depiction is explicit rather than the subject being difficult.",
				}),
			});
			expect(res.status).toBe(200);

			const work = await reload(workId);
			expect(work.maturity).toBe("mature");
			expect(work.maturitySource).toBe("operator");

			const [stored] = await db
				.select()
				.from(workRatingAppeals)
				.where(eq(workRatingAppeals.id, row.id));
			expect(stored.status).toBe("upheld");
			// An appeal refused with no answer is the version of this that teaches creators
			// not to file one.
			expect(stored.resolutionNote).toContain("depiction");
		});

		it("cannot be resolved twice", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const filed = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			const { appeal: row } = await filed.json();
			const resolve = () =>
				req("/api/admin/rating-appeals/resolve", {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: operator },
					body: JSON.stringify({ appealId: row.id, outcome: "granted" }),
				});
			expect((await resolve()).status).toBe(200);
			expect((await resolve()).status).toBe(404);
		});
	});

	describe("what a viewer is and is not told", () => {
		it("shows the rating and the notes on a Work nobody can open", async () => {
			// The warning has to arrive before the thing, not with it — so it rides with the
			// public blurb rather than with the payload.
			const workId = await makeWork({ maturity: "mature", maturityNotes: ["violence"] });
			await patch(workId, { visibility: "released" });

			const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: stranger } });
			expect(res.status).toBe(200);
			const { work } = await res.json();
			expect(work.maturity).toBe("mature");
			expect(work.maturityNotes).toEqual(["violence"]);
		});

		it("never tells a viewer who set the rating", async () => {
			// 🚨 A viewer able to read this could tell a corrected Work from a self-declared
			// one, which is operator information about somebody else's account.
			const workId = await makeWork({ maturity: "general" });
			await patch(workId, { visibility: "released" });
			await correct(workId, "mature");

			const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: stranger } });
			const { work } = await res.json();
			expect(work.maturitySource).toBeUndefined();
			expect(work.maturityLocked).toBeUndefined();
		});

		it("tells the creator their rating was corrected, so they can find the appeal", async () => {
			const workId = await makeWork({ maturity: "general" });
			await correct(workId, "mature");
			const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: creator } });
			const { work } = await res.json();
			expect(work.maturityLocked).toBe(true);
		});
	});
});
