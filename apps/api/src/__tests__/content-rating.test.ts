// SPDX-License-Identifier: Apache-2.0
/**
 * The content rating: declared by a creator, corrected by an operator, appealed by the
 * creator.
 *
 * 🚨 **The appeal half is not a nicety and the tests for it are not optional.** An Adult
 * rating makes a Work invisible to everyone who has not opted in and verified, so an
 * over-cautious call does not merely add a warning to a work — it removes it from most readers'
 * sight, and for a queer coming-of-age story wrongly flagged that is exactly the harm the
 * category exists to prevent, produced by the mechanism meant to prevent it (the wiki's
 * *Content Standards*). A suite that covered only the correction would
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
import {
	moderationActions,
	notifications,
	users,
	workRatingAppeals,
	works,
} from "@anthers/db/schema";
import type { DeclarableMaturity } from "@anthers/shared/content-rating";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `rate_${id}`;
const strangerName = `rateoth_${id}`;

async function signUp(username: string): Promise<string> {
	return (await createAccount(username)).cookie;
}

describe("content ratings", () => {
	let creator: string;
	/** The admin session cookie every operator request below is made with. */
	let operator: string;
	let operatorId: number;
	let stranger: string;
	/** The stranger's session token, sent as the desktop Studio would send it. */
	let strangerToken: string;
	// Needed to read back the notification a correction sends. Notifications cascade with
	// the user, so the existing teardown already covers them.
	let creatorId: number;
	const created: number[] = [];

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${strangerName})`);
		creator = await signUp(creatorName);
		await enablePayouts(creatorName);
		const strangerAccount = await createAccount(strangerName);
		stranger = strangerAccount.cookie;
		strangerToken = strangerAccount.token;
		await enablePayouts(strangerName);
		({ id: operatorId, cookie: operator } = await createAdminFixture("rate-operator"));
		const [row] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName));
		creatorId = row!.id;
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
		await purgeFixtureAccounts([creatorName, strangerName]);
	});

	/**
	 * A private text Work — nothing here needs media, and media needs pg-boss. Anything created is
	 * taken back afterward, including a Work a create that should have been refused made anyway.
	 */
	async function createWork(body: Record<string, unknown>): Promise<Response> {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator },
			// With a body, because a piece of writing with none is refused release (`text_missing`)
			// for a reason that is not this suite's subject.
			body: JSON.stringify({
				type: "text",
				title: `Rating fixture ${id}`,
				bodyHtml: "<p>A rating fixture.</p>",
				...body,
			}),
		});
		if (res.status === 201) created.push((await res.clone().json()).work.id);
		return res;
	}

	async function makeWork(body: Record<string, unknown> = {}): Promise<number> {
		const res = await createWork(body);
		expect(res.status).toBe(201);
		return (await res.json()).work.id;
	}

	/** Every row answered: nothing in it, apart from what `over` marks. */
	const rows = (over: Record<string, string> = {}) => ({
		violence: "none",
		"sexual-themes": "none",
		"substance-use": "none",
		"self-harm": "none",
		horror: "none",
		language: "none",
		...over,
	});

	/** A creator rating a Work, which they do by answering every row of its matrix. */
	const rated = (rating: DeclarableMaturity) => ({ maturityRows: rowsRatedAs(rating) });

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

		it("records the creator's own rating when they answer the matrix at create", async () => {
			const workId = await makeWork({ maturityRows: rows({ violence: "mature" }) });
			const row = await reload(workId);
			expect(row.maturity).toBe("mature");
			expect(row.maturitySource).toBe("creator");
			expect(row.maturityNotes).toEqual(["violence"]);
		});

		it("drops a row it cannot label rather than storing a code nobody can read", async () => {
			const workId = await makeWork({
				maturityRows: rows({ violence: "general", "made-up-note": "mature" }),
			});
			const row = await reload(workId);
			expect(row.maturityNotes).toEqual(["violence"]);
			expect(row.maturityRows).not.toHaveProperty("made-up-note");
		});

		it("refuses a rating named rather than answered, and stores nothing the request carried", async () => {
			// 🚨 A creator rates a Work by answering every row of its matrix (Parker, 2026-09-18).
			// Stripping a named rating instead would answer a save meant to rate the Work with a 200
			// and a Work still unrated, which is a save that appears to work and does not.
			const workId = await makeWork();
			const named = await patch(workId, { maturity: "general", title: "Renamed" });
			expect(named.status).toBe(400);
			expect((await named.json()).code).toBe("rate_through_matrix");
			const noted = await patch(workId, { maturityNotes: ["violence"] });
			expect(noted.status).toBe(400);
			const row = await reload(workId);
			expect(row.maturity).toBe("unrated");
			expect(row.maturityNotes).toEqual([]);
			expect(row.title).toBe(`Rating fixture ${id}`);

			const born = await createWork({ maturity: "general" });
			expect(born.status).toBe(400);
			expect((await born.json()).code).toBe("rate_through_matrix");
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

		it("releases once every row is answered", async () => {
			const workId = await makeWork();
			expect((await patch(workId, rated("general"))).status).toBe(200);
			expect((await patch(workId, { visibility: "released" })).status).toBe(200);
		});

		it("accepts the rating and the release in one request", async () => {
			// The ordinary flow out of the editor, which sends the whole form. Refusing it
			// would mean two round trips to do one thing.
			const workId = await makeWork();
			const res = await patch(workId, { ...rated("mature"), visibility: "released" });
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
			// ⭐ Free and open to everyone, which is now allowed: an Adult Work may be
			// Public Access, and what keeps it away from minors is the verification gate
			// rather than a price.
			const workId = await makeWork({ seedAccess: [{ threshold: 0, allow: true, price: "0" }] });
			const res = await patch(workId, { ...rated("adult"), visibility: "released" });
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.visibility).toBe("released");
			expect(row.maturity).toBe("adult");
			// The creator's own declaration, so nothing is locked — an operator has not
			// touched it, and the second-decision-maker rule is about corrections.
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

		it("refuses a Work holding a rating with no rows behind it", async () => {
			// 🚨 Rated means every row answered, not a rating held. A Work rated before the matrix
			// existed has a General that cannot say whether it means a General form of something or
			// none of it, which is what a reader's filter needs to know. Written straight to the
			// column, because no creator path produces this any more.
			const workId = await makeWork();
			await db
				.update(works)
				.set({ maturity: "general", maturitySource: "creator" })
				.where(eq(works.id, workId));
			const res = await patch(workId, { visibility: "released" });
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("maturity_undeclared");
			// Answering the rows is the whole fix, and it goes in the same save.
			expect((await patch(workId, { ...rated("general"), visibility: "released" })).status).toBe(
				200,
			);
		});
	});

	describe("an operator's correction", () => {
		it("sets the rating, marks it theirs, and writes the log an appeal will read", async () => {
			const workId = await makeWork(rated("general"));
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
			expect(log[0]!.adminActorId).toBe(operatorId);
		});

		it("is not reachable by an ordinary account, and is not advertised to a bearer credential", async () => {
			const workId = await makeWork(rated("general"));
			const body = JSON.stringify({ workId, maturity: "mature" });
			// An Anthers account's session is not an admin session.
			const withCookie = await req("/api/admin/works/rating", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: stranger },
				body,
			});
			expect(withCookie.status).toBe(401);
			const withBearer = await req("/api/admin/works/rating", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${strangerToken}` },
				body,
			});
			expect(withBearer.status).toBe(404);
			expect((await reload(workId)).maturity).toBe("general");
		});

		it("cannot put a Work back to unrated", async () => {
			// That would be un-releasing it by a side door: the release gate refuses an
			// unrated Work, so one already out would be in a state no creator path produces.
			const workId = await makeWork(rated("general"));
			const res = await req("/api/admin/works/rating", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: operator },
				body: JSON.stringify({ workId, maturity: "unrated" }),
			});
			expect(res.status).toBe(400);
		});

		it("🚨 moves a Work to Adult and changes nothing but the rating", async () => {
			// ⭐ **The rung restricts who may reach a Work, never what its creator may charge
			// or earn.** An earlier cut of this closed the Work's free access as part of the
			// correction, on the premise that Adult work may not be free — that premise is
			// retired. Adult work may be free, may be Public Access, and earns the Time Pool
			// like anything else, so a correction that re-priced somebody's work would make
			// the rating a penalty, which it is not.
			const open = [{ threshold: 0, allow: true, price: "0" }];
			const workId = await makeWork({ ...rated("general"), seedAccess: open });
			const res = await correct(workId, "adult");
			expect(res.status).toBe(200);

			const row = await reload(workId);
			expect(row.maturity).toBe("adult");
			expect(row.maturitySource).toBe("operator");
			// Untouched. This is the assertion that would catch a well-meaning future
			// re-introduction of the paywall.
			expect(row.seedAccess).toEqual(open);
		});

		it("tells the creator, because a correction they never hear about cannot be appealed", async () => {
			// 🚨 The half that makes the correction legitimate rather than merely permitted.
			// The appeal path is part of the feature, and an appeal nobody knows to file is
			// the version of it that teaches creators the queue is decorative.
			const workId = await makeWork(rated("general"));
			await correct(workId, "adult");

			// ⚠️ Scoped to THIS Work by its dedupe key, not just to the creator and the
			// kind. Every fixture in this suite belongs to one creator and several tests
			// correct a rating, so a query on `(userId, kind)` returns whichever row the
			// planner reached first — it matched an earlier test's notification once.
			const [note] = await db
				.select()
				.from(notifications)
				.where(
					and(
						eq(notifications.userId, creatorId),
						eq(notifications.kind, "rating_corrected"),
						like(notifications.dedupeKey, `rating-corrected:${workId}:%`),
					),
				);
			expect(note).toBeDefined();
			expect(note.body).toContain("appeal");
			// ⭐ Says plainly that money is not what changed. A creator told only "your work
			// is now Adult" would reasonably assume the worst about their earnings.
			expect(note.body).toContain("still earns the Time Pool");
			// `essential`: a decision taken about their work, not activity on it.
			expect(note.category).toBe("essential");
		});
	});

	describe("the lock, in both directions", () => {
		it("refuses to let the creator lower it, and says where the appeal is", async () => {
			const workId = await makeWork(rated("general"));
			await correct(workId, "mature");

			const res = await patch(workId, rated("general"));
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
			const workId = await makeWork(rated("general"));
			await correct(workId, "mature");

			expect((await patch(workId, rated("adult"))).status).toBe(200);
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
			const workId = await makeWork(rated("mature"));
			await correct(workId, "general");

			const res = await patch(workId, rated("mature"));
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.maturity).toBe("mature");
			expect(row.maturitySource).toBe("creator");
		});

		it("lets a PATCH carrying the unchanged rating through", async () => {
			// The editor sends the whole form on every save, so a save that touches the
			// title must not be refused because it also restated the rating.
			const workId = await makeWork(rated("general"));
			await correct(workId, "mature");
			const res = await patch(workId, { ...rated("mature"), title: "Renamed" });
			expect(res.status).toBe(200);
			expect((await reload(workId)).title).toBe("Renamed");
		});

		it("never locks which rows are marked, only how high they reach", async () => {
			// Notes carry no access consequence, so there is nothing for a lock to protect —
			// and locking them would take a creator's own warnings to their own readers out
			// of their hands.
			const workId = await makeWork(rated("general"));
			await correct(workId, "mature", ["violence"]);
			const res = await patch(workId, { maturityRows: rows({ horror: "mature" }) });
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.maturityNotes).toEqual(["horror"]);
			// And the lock itself is untouched by rows that stay at the operator's rung.
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
			const workId = await makeWork(rated("mature"));
			const res = await appeal(workId, {
				requestedMaturity: "general",
				statement: "This is a coming-of-age story with no explicit content in it.",
			});
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("not_locked");
		});

		it("is filed against an operator's correction", async () => {
			const workId = await makeWork(rated("general"));
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
			const workId = await makeWork(rated("general"));
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
			const workId = await makeWork(rated("general"));
			await correct(workId, "mature");
			expect((await appeal(workId, { requestedMaturity: "general", statement: "" })).status).toBe(
				400,
			);
		});

		it("is not filable by anyone but the Work's creator", async () => {
			const workId = await makeWork(rated("general"));
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
			const workId = await makeWork(rated("general"));
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
			const workId = await makeWork(rated("general"));
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
			expect(stored.resolvedBy).toBe(operatorId);
			// An appeal refused with no answer is the version of this that teaches creators
			// not to file one.
			expect(stored.resolutionNote).toContain("depiction");
		});

		it("cannot be resolved twice", async () => {
			const workId = await makeWork(rated("general"));
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
			const workId = await makeWork({ maturityRows: rows({ violence: "mature" }) });
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
			const workId = await makeWork(rated("general"));
			await patch(workId, { visibility: "released" });
			await correct(workId, "mature");

			const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: stranger } });
			const { work } = await res.json();
			expect(work.maturitySource).toBeUndefined();
			expect(work.maturityLocked).toBeUndefined();
		});

		it("tells the creator their rating was corrected, so they can find the appeal", async () => {
			const workId = await makeWork(rated("general"));
			await correct(workId, "mature");
			const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: creator } });
			const { work } = await res.json();
			expect(work.maturityLocked).toBe(true);
		});
	});

	describe("declared through the rating matrix", () => {
		it("rates a Work at the highest row once every row is answered, and notes each row", async () => {
			const workId = await makeWork();
			const res = await patch(workId, {
				maturityRows: rows({ violence: "mature", language: "general" }),
			});
			expect(res.status).toBe(200);
			const row = await reload(workId);
			expect(row.maturity).toBe("mature");
			expect(row.maturitySource).toBe("creator");
			expect(row.maturityNotes).toEqual(["violence", "language"]);
			// Stored as marked, Not in It and all, which is what a reader's filter can rely on.
			expect(row.maturityRows).toMatchObject({ violence: "mature", horror: "none" });
		});

		it("rates nothing from half a matrix, never un-rates a rated Work, and never releases it", async () => {
			const workId = await makeWork(rated("general"));
			const { language: _left, ...fiveRows } = rows({ violence: "mature" });
			expect((await patch(workId, { maturityRows: fiveRows })).status).toBe(200);
			const row = await reload(workId);
			// The rows are kept for the creator to finish, and the rating stands meanwhile.
			expect(row.maturity).toBe("general");
			expect(row.maturityRows).toMatchObject({ violence: "mature" });
			expect(row.maturityRows).not.toHaveProperty("language");
			// But a rating with an unanswered row behind it is not one release will take.
			const release = await patch(workId, { visibility: "released" });
			expect(release.status).toBe(409);
			expect((await release.json()).code).toBe("maturity_undeclared");
		});

		it("rates Adult from a violence row, which the Rating Standard now allows", async () => {
			const workId = await makeWork();
			expect((await patch(workId, { maturityRows: rows({ violence: "adult" }) })).status).toBe(200);
			expect((await reload(workId)).maturity).toBe("adult");
		});

		it("refuses rows that add up below an operator's correction", async () => {
			const workId = await makeWork(rated("general"));
			expect((await correct(workId, "adult")).status).toBe(200);
			const lower = await patch(workId, { maturityRows: rows({ violence: "mature" }) });
			expect(lower.status).toBe(409);
			expect((await lower.json()).code).toBe("maturity_locked");
			expect((await reload(workId)).maturity).toBe("adult");
			// And rows that reach the operator's rung are the creator's own to mark.
			const same = await patch(workId, { maturityRows: rows({ "sexual-themes": "adult" }) });
			expect(same.status).toBe(200);
		});

		it("gives the creator their matrix back, and a reader the rows their own filter reads", async () => {
			// A reader's filter by kind of content blurs in the browser, so the reader's copy carries
			// the rows. They restate the public notes plus which rows are Not in It, and what stays
			// behind is who set the rating, asserted above.
			const workId = await makeWork();
			// Released, so the stranger is answered with the reader's shape rather than a 404.
			const released = await patch(workId, {
				maturityRows: rows({ horror: "general" }),
				visibility: "released",
			});
			expect(released.status).toBe(200);
			const own = await (
				await req(`/api/content/works/${workId}`, { headers: { Cookie: creator } })
			).json();
			expect(own.work.maturityRows).toMatchObject({ horror: "general" });
			const theirs = await (
				await req(`/api/content/works/${workId}`, { headers: { Cookie: stranger } })
			).json();
			expect(theirs.work.title).toBe(`Rating fixture ${id}`);
			expect(theirs.work.maturityRows).toMatchObject({ horror: "general", violence: "none" });
			expect(theirs.work.maturitySource).toBeUndefined();
		});
	});
});
