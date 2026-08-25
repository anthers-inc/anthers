// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin / operations console API — read-only platform telemetry for operators.
 *
 * Every route is gated by requireAuth + requireAdmin (a 404 to non-admins, so
 * the surface isn't advertised). Data comes from our own Postgres: activity
 * counts + a 14-day series, media transcode state, and pg-boss queue health
 * (the `pgboss` schema). Live-log tailing and DigitalOcean spend deliberately
 * live in the DO dashboard, deep-linked from the frontend rather than proxied
 * here — a thin console over DO's own monitoring, per the task's steer.
 *
 * The telemetry half is read-only by design; job retry/cancel and alerting are
 * still follow-ons. The MODERATION half below is this console's first mutating
 * surface, and it stays inside the same `requireAdmin` gate rather than growing
 * a second admin router with a second answer to "who is an operator?".
 */

import { db } from "@anthers/db/client";
import { rightsRequests } from "@anthers/db/schema";
import {
	isModerationReason,
	isModerationSubjectType,
	MODERATION_NOTE_MAX,
} from "@anthers/shared/moderation";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { QUEUES } from "../jobs/queue.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { loadAbuseQueue } from "../services/abuse-reports.js";
import {
	dmcaSummary,
	loadDmcaQueue,
	loadNotice,
	recordSuit,
	rejectNotice,
	restoreWork,
	takeDownWork,
} from "../services/dmca.js";
import {
	dismissReports,
	hideSubject,
	loadQueue,
	moderationSummary,
	type QueueFilter,
	restoreSubject,
	routeToCopyright,
} from "../services/moderation.js";
import { notify } from "../services/notifications.js";
import {
	clearQuarantine,
	loadQuarantineFindings,
	quarantineSummary,
	quarantineWork,
} from "../services/quarantine.js";

const QUEUE_FILTERS: readonly QueueFilter[] = [
	"reported",
	"comments",
	"ratings",
	"people",
	"hidden",
];

const subjectSchema = z.object({
	subjectType: z.string().refine(isModerationSubjectType, "Unknown subject type"),
	subjectId: z.number().int().positive(),
	note: z.string().max(MODERATION_NOTE_MAX).optional(),
});

const hideSchema = subjectSchema.extend({
	reason: z.string().refine(isModerationReason, "Unknown reason"),
});

/**
 * A quarantine names a Work, never a subject type.
 *
 * Deliberately NOT built on `subjectSchema`: quarantine applies to stored media, and a
 * comment or a rating has none. Reusing the polymorphic shape would invite a caller to
 * send `subjectType: "comment"` and get a route that either silently does nothing or
 * grows a branch for a case that cannot exist.
 *
 * `classification` is free text because the detection vendor is not chosen yet and each
 * one has its own vocabulary — Arachnid answers `csam` / `harmful-abusive-material`,
 * PhotoDNA does not. Constraining it now would mean renaming values later.
 */
const quarantineSchema = z.object({
	workId: z.number().int().positive(),
	classification: z.string().min(1).max(120),
	reportId: z.number().int().positive().optional(),
	note: z.string().max(MODERATION_NOTE_MAX).optional(),
});

const clearQuarantineSchema = z.object({
	workId: z.number().int().positive(),
	note: z.string().max(MODERATION_NOTE_MAX).optional(),
});

// pg-boss job states (v12). We surface the live ones that signal health;
// `completed` rows are pruned by keep_until, so their count is only ever recent.
const JOB_STATES = ["created", "retry", "active", "completed", "cancelled", "failed"] as const;
type JobState = (typeof JOB_STATES)[number];

// postgres-js returns the rows array directly from db.execute(); other drivers
// wrap them in { rows }. Normalize so this is driver-agnostic.
function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
	if (Array.isArray(res)) return res as T[];
	const maybe = (res as { rows?: T[] } | null)?.rows;
	return Array.isArray(maybe) ? maybe : [];
}

const adminRoutes = new Hono()
	.use("*", requireAuth)
	.use("*", requireAdmin)

	// ── Activity ────────────────────────────────────────────────────────────
	// Platform counts + a 14-day sign-up/post series for the chart. One round
	// trip: every figure is a scalar subquery. `::int` keeps them JS numbers.
	.get("/activity", async (c) => {
		const summaryRes = await db.execute(sql`
			SELECT
				(SELECT count(*) FROM users)::int AS users_total,
				(SELECT count(*) FROM users WHERE is_creator)::int AS users_creators,
				(SELECT count(*) FROM users WHERE is_admin)::int AS users_admins,
				(SELECT count(*) FROM users WHERE created_at >= now() - interval '24 hours')::int AS users_new_24h,
				(SELECT count(*) FROM users WHERE created_at >= now() - interval '7 days')::int AS users_new_7d,
				(SELECT count(*) FROM posts)::int AS posts_total,
				(SELECT count(*) FROM posts WHERE is_published)::int AS posts_published,
				(SELECT count(*) FROM posts WHERE created_at >= now() - interval '24 hours')::int AS posts_new_24h,
				(SELECT count(*) FROM posts WHERE created_at >= now() - interval '7 days')::int AS posts_new_7d,
				(SELECT count(*) FROM comments WHERE created_at >= now() - interval '24 hours')::int AS comments_new_24h,
				(SELECT count(*) FROM comments WHERE created_at >= now() - interval '7 days')::int AS comments_new_7d,
				(SELECT count(*) FROM works)::int AS uploads_total
		`);
		const s = rowsOf<Record<string, number>>(summaryRes)[0] ?? {};

		const seriesRes = await db.execute(sql`
			SELECT
				to_char(d.day, 'YYYY-MM-DD') AS date,
				COALESCE(u.n, 0)::int AS signups,
				COALESCE(p.n, 0)::int AS posts
			FROM generate_series((now() - interval '13 days')::date, now()::date, interval '1 day') AS d(day)
			LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM users GROUP BY 1) u ON u.day = d.day
			LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM posts GROUP BY 1) p ON p.day = d.day
			ORDER BY d.day
		`);
		const series = rowsOf<{ date: string; signups: number; posts: number }>(seriesRes);

		return c.json({
			users: {
				total: s.users_total ?? 0,
				creators: s.users_creators ?? 0,
				admins: s.users_admins ?? 0,
				new24h: s.users_new_24h ?? 0,
				new7d: s.users_new_7d ?? 0,
			},
			posts: {
				total: s.posts_total ?? 0,
				published: s.posts_published ?? 0,
				new24h: s.posts_new_24h ?? 0,
				new7d: s.posts_new_7d ?? 0,
			},
			comments: {
				new24h: s.comments_new_24h ?? 0,
				new7d: s.comments_new_7d ?? 0,
			},
			uploads: { total: s.uploads_total ?? 0 },
			series,
		});
	})

	// ── Jobs & queue health ─────────────────────────────────────────────────
	// pg-boss queue state (the `pgboss` schema) + our own media transcodes.
	.get("/jobs", async (c) => {
		// pg-boss creates its schema on first start; guard so a DB that has never
		// run the worker (e.g. a fresh test DB) returns unavailable, not a 500.
		const existsRes = await db.execute(
			sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
		);
		const pgbossPresent = rowsOf<{ present: boolean }>(existsRes)[0]?.present === true;

		// Seed the queue list from our known queues so an idle-but-healthy queue
		// (all jobs completed + pruned → zero rows) still shows up.
		const queues = new Map<string, Record<JobState, number>>();
		const blank = (): Record<JobState, number> =>
			Object.fromEntries(JOB_STATES.map((st) => [st, 0])) as Record<JobState, number>;
		for (const name of Object.values(QUEUES)) queues.set(name, blank());

		let failures: { queue: string; state: string; createdOn: string; error: string }[] = [];

		if (pgbossPresent) {
			const stateRes = await db.execute(sql`
				SELECT name, state::text AS state, count(*)::int AS n
				FROM pgboss.job
				GROUP BY name, state
			`);
			for (const row of rowsOf<{ name: string; state: string; n: number }>(stateRes)) {
				if (!queues.has(row.name)) queues.set(row.name, blank());
				const bucket = queues.get(row.name);
				if (bucket && (JOB_STATES as readonly string[]).includes(row.state)) {
					bucket[row.state as JobState] = row.n;
				}
			}

			const failRes = await db.execute(sql`
				SELECT name, state::text AS state, created_on, output
				FROM pgboss.job
				WHERE state IN ('failed', 'cancelled')
				ORDER BY COALESCE(completed_on, created_on) DESC
				LIMIT 25
			`);
			failures = rowsOf<{
				name: string;
				state: string;
				created_on: string;
				output: unknown;
			}>(failRes).map((r) => ({
				queue: r.name,
				state: r.state,
				createdOn: r.created_on,
				error: extractError(r.output),
			}));
		}

		const queueHealth = [...queues.entries()]
			.map(([name, counts]) => ({ name, ...counts }))
			.sort((a, b) => a.name.localeCompare(b.name));

		// Our own media transcode table (video/audio processing).
		const transcodeStateRes = await db.execute(sql`
			SELECT status, count(*)::int AS n FROM transcoding_jobs GROUP BY status
		`);
		const transcodeCounts: Record<string, number> = {};
		for (const r of rowsOf<{ status: string; n: number }>(transcodeStateRes)) {
			transcodeCounts[r.status] = r.n;
		}

		const stuckRes = await db.execute(sql`
			SELECT id, media_type, status, error_message, updated_at
			FROM transcoding_jobs
			WHERE status = 'failed'
			   OR (status = 'processing' AND updated_at < now() - interval '30 minutes')
			ORDER BY updated_at DESC
			LIMIT 25
		`);
		const transcodeProblems = rowsOf<{
			id: number;
			media_type: string;
			status: string;
			error_message: string | null;
			updated_at: string;
		}>(stuckRes).map((r) => ({
			id: r.id,
			mediaType: r.media_type,
			status: r.status,
			// A processing row this old hasn't heartbeat in 30m — flag it as stuck.
			stuck: r.status === "processing",
			error: r.error_message ?? "",
			updatedAt: r.updated_at,
		}));

		return c.json({
			pgboss: { available: pgbossPresent, queues: queueHealth, failures },
			transcodes: { counts: transcodeCounts, problems: transcodeProblems },
		});
	})

	// ── Data-rights requests ────────────────────────────────────────────────
	// The operator's side of 51.05's 30-day promise. This exists because a deadline
	// nobody can see is not a mechanism — requests landing in one person's inbox was
	// the state this replaces. Overdue is computed here rather than stored so it
	// cannot go stale.
	.get("/rights-requests", async (c) => {
		const rows = await db
			.select()
			.from(rightsRequests)
			.orderBy(rightsRequests.status, rightsRequests.dueAt);
		const now = Date.now();
		return c.json({
			requests: rows.map((r) => ({
				...r,
				overdue: r.status === "open" && new Date(r.dueAt).getTime() < now,
				daysLeft: Math.ceil((new Date(r.dueAt).getTime() - now) / 86_400_000),
			})),
			open: rows.filter((r) => r.status === "open").length,
			overdue: rows.filter((r) => r.status === "open" && new Date(r.dueAt).getTime() < now).length,
		});
	})

	.post(
		"/rights-requests/:id/resolve",
		zValidator("json", z.object({ note: z.string().max(2000).optional() })),
		async (c) => {
			const id = Number(c.req.param("id"));
			const [row] = await db
				.update(rightsRequests)
				.set({
					status: "resolved",
					resolvedAt: new Date(),
					resolutionNote: (c.req.valid("json").note ?? "").trim(),
				})
				.where(and(eq(rightsRequests.id, id), eq(rightsRequests.status, "open")))
				.returning();
			if (!row) return c.json({ error: "Not found or already resolved" }, 404);

			// The requester is told it was answered. Closing a ticket silently is how a
			// 30-day promise becomes a 30-day silence.
			if (row.userId != null) {
				await notify({
					userId: row.userId,
					category: "essential",
					kind: "rights_request_resolved",
					title: "Your data request has been answered",
					body: row.resolutionNote || "We've responded to the request you made.",
					linkPath: "/settings",
					dedupeKey: `rights-request-resolved:${row.id}`,
				});
			}
			return c.json({ resolved: true });
		},
	)

	// ── Moderation ──────────────────────────────────────────────────────────
	// The operator queue and the two decisions that act on it. Everything here
	// delegates to services/moderation.ts; in particular, nothing on this route
	// deletes a row — hiding is a state transition, and the record of it is what
	// makes appeals and creator-side tools additions rather than migrations.
	.get("/moderation", async (c) => {
		const requested = c.req.query("filter") ?? "reported";
		const filter = (QUEUE_FILTERS as readonly string[]).includes(requested)
			? (requested as QueueFilter)
			: "reported";

		const [items, summary] = await Promise.all([loadQueue(filter), moderationSummary()]);
		return c.json({ filter, items, summary });
	})

	// `not_moderatable` is what a person report gets, and it is a 400 rather than a 501
	// because the request is well-formed and simply asks for something that does not
	// exist as an action: hiding an account is suspension, which is not built. The
	// console reads `moderatable` off the queue item and doesn't offer the button —
	// this is the backstop for a client that does anyway.
	.post("/moderation/hide", zValidator("json", hideSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId, reason, note } = c.req.valid("json");
		const result = await hideSubject({
			subjectType,
			subjectId,
			actorId: user.id,
			reason,
			note,
		});
		if (result === "not_moderatable") {
			return c.json(
				{ error: "An account can't be hidden — suspension isn't built.", code: "not_moderatable" },
				400,
			);
		}
		if (!result) return c.json({ error: "Subject not found" }, 404);
		return c.json(result);
	})

	.post("/moderation/restore", zValidator("json", subjectSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId, note } = c.req.valid("json");
		const result = await restoreSubject({ subjectType, subjectId, actorId: user.id, note });
		if (result === "not_moderatable") {
			return c.json(
				{ error: "An account can't be restored — it was never hideable.", code: "not_moderatable" },
				400,
			);
		}
		if (!result) return c.json({ error: "Subject not found" }, 404);
		return c.json(result);
	})

	// Clear a subject's reports without touching the content — the "I looked, it's
	// fine" outcome. Distinct from hiding, and it has to be, or the only way to
	// empty the queue would be to take things down.
	.post("/moderation/dismiss", zValidator("json", subjectSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId } = c.req.valid("json");
		const result = await dismissReports({ subjectType, subjectId, actorId: user.id });
		return c.json(result);
	})

	// The route-out: this report is really a copyright claim. Clears the reports
	// and answers the reporter with the path that can handle it — and takes NO
	// action on the content, because a bare user report is not a DMCA notice and
	// must never cause a removal. See `routeToCopyright`.
	.post("/moderation/route-to-copyright", zValidator("json", subjectSchema), async (c) => {
		const user = c.get("user");
		const { subjectType, subjectId } = c.req.valid("json");
		const result = await routeToCopyright({ subjectType, subjectId, actorId: user.id });
		return c.json(result);
	})

	// ── Quarantine ──────────────────────────────────────────────────────────────
	// Child-safety quarantine: material taken out of reach of everybody, purchasers
	// included. Separate from both queues above because it is not a moderation
	// judgment about ordinary content — it is a detection-and-preservation path with
	// a different destination, and running it through the ordinary queue would lose
	// it (40.12, "Why the reporting path is not a moderation feature").
	//
	// 🚨 **Everything here is metadata, and there is no endpoint that renders the
	// material.** § 5.2 of 60.13 makes that a policy commitment: the operator sees the
	// finding — key, Work, uploader, classification, timestamps — and never the image.
	// Adding a preview route would require amending a policy, not just this file.
	.get("/quarantine", async (c) => {
		const includeCleared = c.req.query("cleared") === "1";
		const [findings, summary] = await Promise.all([
			loadQuarantineFindings({ includeCleared }),
			quarantineSummary(),
		]);
		return c.json({ findings, summary });
	})

	// Quarantine a Work. The realistic caller is an operator acting on a floor-level
	// report; `reportId` links the two so the finding cites what triggered it.
	//
	// ⚠️ **This does not file a CyberTipline report and must not.** Reporting stays
	// manual, by the Designated Child Safety Contact, following 60.14 — a hash match
	// is a reporting trigger and a report filed by a route is one nobody decided to
	// make. What this does is take the material out of reach and preserve it, which is
	// what has to be true *before* that person starts.
	.post("/quarantine", zValidator("json", quarantineSchema), async (c) => {
		const user = c.get("user");
		const { workId, classification, reportId, note } = c.req.valid("json");
		try {
			const result = await quarantineWork({
				workId,
				source: "operator",
				classification,
				actorId: user.id,
				reportId: reportId ?? null,
				note,
			});
			return c.json(result);
		} catch {
			return c.json({ error: "Work not found" }, 404);
		}
	})

	// Put it back, for a finding that turned out to be wrong.
	//
	// 🚨 The preservation hold is deliberately NOT lifted by this. A quarantine is
	// cleared because somebody looked and the finding was mistaken; a preservation
	// obligation ends on a statutory clock, decided separately. See `clearQuarantine`.
	.post("/quarantine/clear", zValidator("json", clearQuarantineSchema), async (c) => {
		const user = c.get("user");
		const { workId, note } = c.req.valid("json");
		const result = await clearQuarantine({ workId, actorId: user.id, note });
		if (result.objectsRestored === 0 && !result.visibility) {
			return c.json({ error: "No open quarantine for that Work" }, 404);
		}
		return c.json(result);
	})

	// ── Public illegal-content reports ──────────────────────────────────────────
	// The no-account intake's queue. Separate from `/moderation` above because the
	// tables are separate and for the reason 40.12 gives — this is a report pipeline
	// with a different destination rather than a judgment about ordinary content.
	// Every one of these has already been emailed to `abuse@` if its reason is on the
	// floor; the queue is where the ones that are not get answered.
	.get("/abuse-reports", async (c) => {
		const includeClosed = c.req.query("closed") === "1";
		return c.json({ reports: await loadAbuseQueue({ includeClosed }) });
	})

	// ── DMCA ────────────────────────────────────────────────────────────────────
	// The operator's DMCA queue, separate from the moderation queue. Different
	// clocks, different record, and — per the Keepers model — non-delegable floor
	// work. Behind `requireAdmin` today; the capability is named `floor` in a
	// comment on the service so the Keepers migration is a rename rather than a
	// redesign.
	//
	// 🚨 A user report is NOT a DMCA notice. The moderation queue carries `illegal`
	// and `other` reasons, and an operator seeing a copyright complaint filed that
	// way needs a one-click "this is a copyright claim → here is the path" — but a
	// bare user report must not trigger removal. The route-out is operator-side:
	// it answers the reporter without treating the report as a notice.
	.get("/dmca", async (c) => {
		const [items, summary] = await Promise.all([loadDmcaQueue(), dmcaSummary()]);
		return c.json({ items, summary });
	})

	// Load a single notice with full detail for the operator's review.
	.get("/dmca/:id", async (c) => {
		const notice = await loadNotice(Number(c.req.param("id")));
		if (!notice) return c.json({ error: "Not found" }, 404);
		return c.json(notice);
	})

	// Act on a notice — does four things in one transaction (via the service):
	// disable the material, append to the audit log, notify the creator (with
	// the counter-notice route + the exposure stated), and acknowledge the
	// complainant. No automated removal — the operator decided.
	.post(
		"/dmca/:id/act",
		zValidator("json", z.object({ note: z.string().max(MODERATION_NOTE_MAX).optional() })),
		async (c) => {
			const user = c.get("user");
			const { note } = c.req.valid("json");
			const result = await takeDownWork({
				noticeId: Number(c.req.param("id")),
				actorId: user.id,
				note,
			});
			if (result === "already_taken_down") {
				return c.json(
					{ error: "This Work is already taken down.", code: "already_taken_down" },
					409,
				);
			}
			if (!result) return c.json({ error: "Notice or Work not found" }, 404);
			return c.json(result);
		},
	)

	// Reject a notice — a first-class outcome with the § 512(c)(3)(B)(ii)
	// reach-back. The rejection copy (in the note) names which element failed,
	// and the service records the reach-back.
	.post(
		"/dmca/:id/reject",
		zValidator("json", z.object({ note: z.string().max(MODERATION_NOTE_MAX).optional() })),
		async (c) => {
			const user = c.get("user");
			const { note } = c.req.valid("json");
			const result = await rejectNotice({
				noticeId: Number(c.req.param("id")),
				actorId: user.id,
				note,
			});
			if (!result) return c.json({ error: "Notice not found" }, 404);
			return c.json(result);
		},
	)

	// Restore a Work manually. The scheduled sweep restores automatically at the
	// 10–14 business day window; this is for an operator who decides to restore
	// early (e.g., the complainant withdrew the notice).
	.post(
		"/dmca/:id/restore",
		zValidator("json", z.object({ note: z.string().max(MODERATION_NOTE_MAX).optional() })),
		async (c) => {
			const user = c.get("user");
			const { note } = c.req.valid("json");
			const result = await restoreWork({
				noticeId: Number(c.req.param("id")),
				actorId: user.id,
				note,
			});
			if (!result) return c.json({ error: "Notice or Work not found" }, 404);
			return c.json(result);
		},
	)

	// Record that the complainant filed a court action (§ 512(g)(2)(C)). This
	// prevents the restore timer from firing — the sweep checks `suitFiledAt`.
	.post("/dmca/:id/suit", async (c) => {
		const user = c.get("user");
		const result = await recordSuit({
			noticeId: Number(c.req.param("id")),
			actorId: user.id,
		});
		if (!result) return c.json({ error: "Notice not found" }, 404);
		return c.json(result);
	});

/** Pull a readable message out of a pg-boss job's `output` jsonb (shape varies). */
function extractError(output: unknown): string {
	if (!output) return "";
	if (typeof output === "string") return output;
	if (typeof output === "object") {
		const o = output as Record<string, unknown>;
		if (typeof o.message === "string") return o.message;
		if (typeof o.value === "string") return o.value;
		try {
			return JSON.stringify(output).slice(0, 500);
		} catch {
			return "";
		}
	}
	return String(output);
}

export { adminRoutes };
