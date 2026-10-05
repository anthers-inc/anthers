// SPDX-License-Identifier: Apache-2.0
/**
 * Finding the gaps between what Anthers' rows would derive and the records actually on the
 * network, on an operator's ask.
 *
 * The nightly `reconcile-listings` sweep catches the structural gaps — a URI that should not
 * exist, a publishable row with none — by query. What it cannot see is **content drift**: a
 * row edited in a way the record should have followed, where the enqueue was lost and the
 * record still says what the row used to say. Only reading the record back from its
 * repository and diffing it against what the mapper derives now can find that, which is why
 * this module exists and why it is an operator surface rather than part of the sweep: it
 * fetches, and a per-row fetch across every record is not a cron-shaped cost.
 *
 * 🚨 **The derived record is compared, never the columns.** The mappers are the same pure
 * functions the write path uses (`workToRecord` and its siblings), so a drift report cannot
 * disagree with what a re-sync would write — a report saying "drift" is a report that
 * "re-sync now" would settle exactly.
 *
 * 🚨 **A fetched record is validated against its own Lexicon before it is diffed.** The
 * network record is whatever whoever wrote there left; validating first means the diff
 * reports a malformed record as malformed rather than producing nonsense field comparisons
 * against a shape nobody wrote.
 *
 * 🚨 **A record standing on an unpublishable row is its own finding, checked first** — the
 * disclosure case. The structural sweep catches some of this by SQL; the fetch half reports
 * the rest, including a Work withdrawn or rated Adult whose record is still being advertised.
 *
 * ⚠️ **Reading is through the record's own PDS**, the address `recordUrlFor` builds from the
 * stored URI and the account's `atproto_pds_url` — the record lives in the creator's
 * repository, wherever that is, and asking Anthers' AppView would answer a different
 * question. An unreadable record is reported `blocked` with the error rather than guessed
 * about: "cannot read" and "reads and disagrees" are different findings.
 */
import { db } from "@anthers/db";
import { posts, projects, users, works } from "@anthers/db/schema";
import {
	type LexiconValidator,
	postRecord,
	projectRecord,
	workRecord,
} from "@anthers/shared/lexicons";
import { eq } from "drizzle-orm";
import {
	type PostRecord,
	type ProjectRecord,
	postToRecord,
	projectToRecord,
	unpublishablePostReason,
	unpublishableProjectReason,
} from "./atproto-creator-records.js";
import { POST_COLLECTION, PROJECT_COLLECTION } from "./atproto-record-plan.js";
import {
	type PublishableWork,
	unpublishableReason,
	type WorkRecord,
	workToRecord,
} from "./atproto-records.js";
import { recordUrlFor, WORK_COLLECTION } from "./atproto-repo.js";
import { syncPostRecord, syncProjectRecord } from "./creator-record-listing.js";
import { syncWorkListing } from "./work-listing.js";

/** How many rows one report will walk, per kind — the same shape of ceiling the sweep uses. */
const REPORT_LIMIT = 500;

/** Where a Work's public page lives — the same resolution `work-listing.ts` uses. */
function baseUrl(): string {
	return process.env.FRONTEND_URL?.trim() || "https://anthers.org";
}

/**
 * Whether one row's record and row agree, as the report states it:
 * - `match` — the record equals what the row derives now.
 * - `drift` — both exist and differ (including: the fetched record fails its own Lexicon).
 * - `missing` — the row is publishable and has no URI.
 * - `should_not_exist` — the row must not be published and a URI stands anyway.
 * - `blocked` — a URI exists but the record could not be read; agreement is unknown.
 * - `not_publishable` — the row derives no record and carries no URI; consistent.
 */
export type DriftStatus =
	| "match"
	| "drift"
	| "missing"
	| "should_not_exist"
	| "blocked"
	| "not_publishable";

export interface DriftReportRow {
	kind: "work" | "post" | "project";
	id: number;
	/** The row's title or slug, for the operator to recognize it by. */
	label: string;
	/** The creator's handle, for the same reason. */
	creatorHandle: string | null;
	status: DriftStatus;
	/** The stored address, when the row carries one. */
	uri: string | null;
	/** What the row derives now — the thing a re-sync would write. Null when unpublishable. */
	derived: WorkRecord | PostRecord | ProjectRecord | null;
	/** The record as read from the network, when one could be read or attempted. */
	fetched: { record: unknown } | { error: string } | null;
	/** Why the row derives no record — the `unpublishable*Reason` value, when it does not. */
	unpublishableReason: string | null;
}

export interface DriftReport {
	generatedAt: string;
	/** Per-status tallies, so a summary line reads without walking the rows. */
	counts: { [s in DriftStatus]: number } & { works: number; posts: number; projects: number };
	rows: DriftReportRow[];
}

/** A record fetch's outcome. */
type Fetched = { ok: true; record: unknown } | { ok: false; error: string };

/**
 * Read one record from the repository it lives in: the record's own PDS, through
 * `com.atproto.repo.getRecord` — the address `recordUrlFor` builds and nothing else.
 */
async function fetchRecord(
	atUri: string,
	pdsUrl: string | null | undefined,
	fetchImpl: typeof fetch,
): Promise<Fetched> {
	const url = recordUrlFor(atUri, pdsUrl);
	if (!url) return { ok: false, error: "no readable record URL (malformed URI or PDS)" };
	try {
		const res = await fetchImpl(url);
		if (!res.ok) return { ok: false, error: `getRecord answered ${res.status}` };
		const body = (await res.json()) as { value?: unknown };
		// getRecord answers `{ uri, cid, value }`; the value is the record.
		if (!body || typeof body !== "object" || !("value" in body)) {
			return { ok: false, error: "getRecord answered without a record value" };
		}
		return { ok: true, record: body.value };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Check a fetched record is the collection it claimed and passes its own Lexicon. */
function validate(
	collection: string,
	record: unknown,
	validator: LexiconValidator,
): { ok: true } | { ok: false; error: string } {
	if (
		!record ||
		typeof record !== "object" ||
		(record as { $type?: unknown }).$type !== collection
	) {
		return { ok: false, error: `record is not a ${collection}` };
	}
	const parsed = validator.safeParse(record);
	if (!parsed.success)
		return { ok: false, error: `record fails its own Lexicon: ${String(parsed.error)}` };
	return { ok: true };
}

/**
 * Deep equality on JSON-shaped values — key-order-insensitive, and `undefined` counts as
 * absent so a mapper omitting an optional field matches a record that lacks it.
 */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
	}
	const ka = Object.keys(a as object).filter(
		(k) => (a as Record<string, unknown>)[k] !== undefined,
	);
	const kb = Object.keys(b as object).filter(
		(k) => (b as Record<string, unknown>)[k] !== undefined,
	);
	if (ka.length !== kb.length) return false;
	return ka.every(
		(k) =>
			Object.hasOwn(b as object, k) &&
			sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

/** Status + shared fetch outcome for one row, once per kind's loop body. */
interface RowOutcome {
	status: DriftStatus;
	fetchedShaped: { record: unknown } | { error: string } | null;
}

/**
 * Classify one row against its derived record and its fetched one.
 *
 * 🚨 **The order of the branches is the report's honesty.** Disclosure first (a record on an
 * unpublishable row), then unreadable, then missing, and only then the diff — so a row in two
 * kinds of trouble is reported by the more serious one. The structural sweep's asymmetry in
 * the same direction: a disclosure is live, a missing listing is merely absent.
 */
function classify(
	reason: string | null,
	uri: string | null,
	derived: WorkRecord | PostRecord | ProjectRecord | null,
	fetched: Fetched | null,
	validateFetched: (record: unknown) => { ok: true } | { ok: false; error: string },
): RowOutcome {
	const fetchedShaped = fetched
		? fetched.ok
			? { record: fetched.record }
			: { error: fetched.error }
		: null;

	if (fetched && !fetched.ok) {
		// A URI that could not be read. On an unpublishable row that is still the disclosure
		// case — the record is presumably still standing — so reason outranks the fetch.
		return { status: reason !== null ? "should_not_exist" : "blocked", fetchedShaped };
	}
	if (reason !== null) {
		return uri
			? { status: "should_not_exist", fetchedShaped }
			: { status: "not_publishable", fetchedShaped };
	}
	if (!uri) return { status: "missing", fetchedShaped };
	if (!fetched) return { status: "blocked", fetchedShaped };
	const check = validateFetched(fetched.record);
	if (!check.ok) return { status: "drift", fetchedShaped };
	if (!derived || sameJson(derived, fetched.record)) {
		// A row whose mapper produced a record that equals what stands, or (impossible while
		// reason is null, but checked rather than assumed) derived nothing at all.
		return { status: derived ? "match" : "not_publishable", fetchedShaped };
	}
	return { status: "drift", fetchedShaped };
}

/**
 * The drift report — Works, then posts, then projects.
 *
 * Works are walked unconditionally rather than through the reconcile job's nets: the fetch
 * makes content drift visible, and nets that select only "probably in disagreement" rows
 * would reproduce exactly the blind spot this module exists to close. The cost is one
 * getRecord per row with a URI, bounded by the per-kind limit — an operator ask, not a cron.
 */
export async function driftReport(
	opts: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<DriftReport> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const limit = opts.limit ?? REPORT_LIMIT;
	const rows: DriftReportRow[] = [];
	const counts = {
		match: 0,
		drift: 0,
		missing: 0,
		should_not_exist: 0,
		blocked: 0,
		not_publishable: 0,
		works: 0,
		posts: 0,
		projects: 0,
	};

	// ── Works ────────────────────────────────────────────────────────────
	//
	// Every Work, not only those with a URI: "publishable with no record" and "unpublishable"
	// are findings too, and the left join keeps the creator's PDS URL beside the row so the
	// fetch can address the repository the record actually went into.
	const workRows = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			type: works.type,
			title: works.title,
			description: works.description,
			slug: works.slug,
			publicId: works.publicId,
			releasedAt: works.releasedAt,
			visibility: works.visibility,
			takedownStatus: works.takedownStatus,
			quarantineStatus: works.quarantineStatus,
			maturity: works.maturity,
			streamEnabled: works.streamEnabled,
			downloadEnabled: works.downloadEnabled,
			access: works.access,
			credits: works.credits,
			atprotoUri: works.atprotoUri,
			handle: users.atprotoHandle,
			pdsUrl: users.atprotoPdsUrl,
		})
		.from(works)
		.leftJoin(users, eq(users.id, works.creatorId))
		.orderBy(works.id)
		.limit(limit);

	for (const w of workRows) {
		counts.works++;
		const reason = unpublishableReason(w as PublishableWork);
		const derived =
			reason === null ? workToRecord(w as PublishableWork, { baseUrl: baseUrl() }) : null;
		const fetched = w.atprotoUri ? await fetchRecord(w.atprotoUri, w.pdsUrl, fetchImpl) : null;
		const { status, fetchedShaped } = classify(
			reason,
			w.atprotoUri ?? null,
			derived,
			fetched,
			(r) => validate(WORK_COLLECTION, r, workRecord),
		);
		rows.push({
			kind: "work",
			id: w.id,
			label: w.title?.trim() || `#${w.id}`,
			creatorHandle: w.handle || null,
			status,
			uri: w.atprotoUri ?? null,
			derived,
			fetched: fetchedShaped,
			unpublishableReason: reason,
		});
		counts[status]++;
	}

	// ── Posts ────────────────────────────────────────────────────────────
	//
	// A post's record carries the BODY — the one place a record is more than a listing — so
	// content drift here is a user-visible lie about what somebody wrote, not just about
	// where it points. The query keeps `body` beside the publishability columns, which is
	// exactly the pairing the mapper's docblock warns must not degrade.
	const postRows = await db
		.select({
			id: posts.id,
			creatorId: posts.creatorId,
			slug: posts.slug,
			publicId: posts.publicId,
			isPublished: posts.isPublished,
			publishedAt: posts.publishedAt,
			body: posts.body,
			atprotoUri: posts.atprotoUri,
			handle: users.atprotoHandle,
			pdsUrl: users.atprotoPdsUrl,
		})
		.from(posts)
		.leftJoin(users, eq(users.id, posts.creatorId))
		.orderBy(posts.id)
		.limit(limit);

	for (const p of postRows) {
		counts.posts++;
		const reason = unpublishablePostReason(p);
		const derived = reason === null ? postToRecord(p, { baseUrl: baseUrl() }) : null;
		const fetched = p.atprotoUri ? await fetchRecord(p.atprotoUri, p.pdsUrl, fetchImpl) : null;
		const { status, fetchedShaped } = classify(
			reason,
			p.atprotoUri ?? null,
			derived,
			fetched,
			(r) => validate(POST_COLLECTION, r, postRecord),
		);
		rows.push({
			kind: "post",
			id: p.id,
			label: p.slug,
			creatorHandle: p.handle || null,
			status,
			uri: p.atprotoUri ?? null,
			derived,
			fetched: fetchedShaped,
			unpublishableReason: reason,
		});
		counts[status]++;
	}

	// ── Projects ─────────────────────────────────────────────────────────
	const projectRows = await db
		.select({
			id: projects.id,
			creatorId: projects.creatorId,
			slug: projects.slug,
			title: projects.title,
			description: projects.description,
			isPublished: projects.isPublished,
			atprotoUri: projects.atprotoUri,
			handle: users.atprotoHandle,
			pdsUrl: users.atprotoPdsUrl,
		})
		.from(projects)
		.leftJoin(users, eq(users.id, projects.creatorId))
		.orderBy(projects.id)
		.limit(limit);

	for (const pr of projectRows) {
		counts.projects++;
		const reason = unpublishableProjectReason(pr);
		const derived = reason === null ? projectToRecord(pr, { baseUrl: baseUrl() }) : null;
		const fetched = pr.atprotoUri ? await fetchRecord(pr.atprotoUri, pr.pdsUrl, fetchImpl) : null;
		const { status, fetchedShaped } = classify(
			reason,
			pr.atprotoUri ?? null,
			derived,
			fetched,
			(r) => validate(PROJECT_COLLECTION, r, projectRecord),
		);
		rows.push({
			kind: "project",
			id: pr.id,
			label: pr.title?.trim() || pr.slug,
			creatorHandle: pr.handle || null,
			status,
			uri: pr.atprotoUri ?? null,
			derived,
			fetched: fetchedShaped,
			unpublishableReason: reason,
		});
		counts[status]++;
	}

	return { generatedAt: new Date().toISOString(), counts, rows };
}

/**
 * One row's re-sync, the admin "make both agree now" action.
 *
 * 🚨 **This is the existing sync functions called in place, not a second implementation.**
 * The per-event enqueue and the nightly sweep both converge on the same functions eventually;
 * running one row now is that path with no queue in between, so the operator sees the plan
 * outcome the worker would only log. The row is re-read inside each sync, so the action is
 * idempotent and a duplicate click costs one read.
 *
 * ⚠️ **No fetch seam is offered here, deliberately.** The sync's writer opens its own
 * session against the account's server, so a stubbed fetch would break that session rather
 * than the record write — a caller wanting determinism stubs `queue.send`, as the suites do,
 * and the write itself goes to the network the session provides.
 */
export async function resyncRecord(
	kind: "work" | "post" | "project",
	id: number,
): Promise<
	| { status: "synced"; plan: unknown; uri: string | null }
	| { status: "skipped"; reason: string }
	| { status: "failed"; error: string }
> {
	if (kind === "work") {
		const result = await syncWorkListing(id);
		if (result.status === "synced") return { status: "synced", plan: result.plan, uri: result.uri };
		if (result.status === "skipped") return { status: "skipped", reason: result.reason };
		return { status: "failed", error: result.error };
	}
	const sync = kind === "post" ? syncPostRecord : syncProjectRecord;
	const result = await sync(id);
	if (result.status === "synced") return { status: "synced", plan: result.plan, uri: result.uri };
	if (result.status === "skipped") return { status: "skipped", reason: result.reason };
	return { status: "failed", error: result.error };
}
