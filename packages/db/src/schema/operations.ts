// SPDX-License-Identifier: Apache-2.0
/**
 * Resource snapshots — the stored trend behind the admin console's Resources section.
 *
 * org — operational telemetry about Anthers' own infrastructure, never a creator's anything.
 *
 * 🚨 **The writer is a local operator script, not the app.** DigitalOcean's per-app CPU and
 * memory metrics are reachable only through the monitoring API, which the app has no
 * credentials for — and inventing a server-side DO credentials path would widen the credential
 * surface for a question an operator can answer from their own machine. So
 * `scripts/resource-snapshot.ts` runs `doctl` locally, resolves the instance shape from the
 * live app spec, and appends a row per component here, through this same `@anthers/db/client`
 * the apps use. The endpoint (`routes/admin.ts` § Resources) and the page render from these
 * rows and from nothing else: the API never talks to DigitalOcean.
 *
 * **The columns are designed from the two surfaces doctl actually gives.** `doctl apps get`
 * answers `instance_size_slug` and `instance_count` per component; the monitoring metrics API
 * answers CPU%, memory% and restart count as time series. A metric the script could not
 * retrieve is stored as NULL with the reason in `notes` — never as zero, which would read as a
 * healthy reading nobody took.
 */

import { relations } from "drizzle-orm";
import {
	index,
	integer,
	jsonb,
	pgTable,
	real,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { adminAccounts } from "./admin.js";
import { users } from "./auth.js";

// org — operational telemetry about Anthers' own infrastructure, never a creator's anything.
export const resourceSnapshots = pgTable(
	"resource_snapshots",
	{
		id: serial("id").primaryKey(),
		/** When the snapshot was taken — the trend's x-axis, not the row's insert time. */
		takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
		/**
		 * The App Platform component name from the live spec: api, worker, migrate, web, admin.
		 * Not a foreign key because it names a spec-side component, not a row here.
		 */
		component: text("component").notNull(),
		/** The live spec's `instance_size_slug`, or null for a static site (none exists). */
		instanceSize: text("instance_size"),
		/** The live spec's `instance_count`, or null for a static site. */
		instanceCount: integer("instance_count"),
		/** CPU utilization percent over the snapshot's window. Null with a reason, never zero. */
		cpuPct: real("cpu_pct"),
		/** Memory utilization percent over the snapshot's window. Null with a reason, never zero. */
		memoryPct: real("memory_pct"),
		/**
		 * Restarts over the snapshot's window — the OOM detector. Null with a reason, never
		 * zero-as-guess; a genuine zero restarts is a real stored 0.
		 */
		restartCount: integer("restart_count"),
		/**
		 * Why a metric column is null, in the script's own words ("monitoring API answered
		 * 503"). Empty when every metric was retrieved.
		 */
		notes: text("notes").notNull().default(""),
	},
	(table) => [
		// The trend query walks (component, taken_at) in order, per component, newest first.
		index("idx_resource_snapshots_component_taken").on(table.component, table.takenAt),
	],
);

// org — operational telemetry about Anthers' own infrastructure, never a creator's anything,
// the same classification `resource_snapshots` carries — and that includes the rate limiter's
// counters, which are records about requesters' behavior, not rows any creator's node holds.
/**
 * The per-IP rate limiter's counters. Keyed (door, ip), one row per door per address inside
 * its window; a window rolls by `reset_at`, the count is spent by `checkRate`'s atomic
 * upsert, and old rows are pruned alongside the credentials they outlived.
 */
export const rateLimits = pgTable(
	"rate_limits",
	{
		id: serial("id").primaryKey(),
		/** The door the limit guards (e.g. `auth-code-send`, `parental-pin`) — namespaced so doors cannot share budgets. */
		door: text("door").notNull(),
		/** The client address as the edge's own hop presented it (the last X-Forwarded-For entry). */
		ip: text("ip").notNull(),
		/** Requests seen inside the current window. */
		count: integer("count").notNull().default(0),
		/** When the window rolls. Stamped at first sight of the key, never moved by volume. */
		resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		// The upsert's conflict target and the prune's walk, one shape each.
		uniqueIndex("idx_rate_limits_door_ip").on(table.door, table.ip),
		index("idx_rate_limits_reset").on(table.resetAt),
	],
);

// org — an issue report is an operator-queue item about the site itself, addressed to the
// org and never a creator's anything, for the same reason `abuse_reports` is org. The
// reporter is often a member of the public with no account at all, so the row's subject is
// Anthers' own surface rather than anybody's node content — there is nothing here a
// creator's node could hold.
/**
 * A bug or defect report filed through the public Issue Reports page.
 *
 * 🚨 **This is NOT a moderation report and must never be mistaken for the reporting
 * pipeline.** `abuse_reports` is illegal-content notice-and-action with statutory clocks,
 * escalation mail and a floor; this is plain bug intake with none of that — no mail sends,
 * no legal reasons, no statute behind it. Keeping it a separate table with a separate
 * service and a separate queue is what keeps the two from drifting into each other, the
 * same division `services/dmca.ts` argues for. Nothing here ever writes to
 * `abuse_reports`, and nothing there ever reads this.
 *
 * **The row is a report item, never a work item.** An issue lands here, is read in the
 * admin console, and is marked ingested once actual work in the project's own task
 * tracker will handle it — the tracker is where the work items live, and this table
 * deliberately does not grow statuses ("triaged", "in progress", "fixed") that would
 * make it a second, competing tracker. The only states are open (nobody has read it) and
 * ingested (a task owns it now).
 *
 * ⚠️ **A fixture in a test must mark itself as one**, in `summary` or `details` — the
 * admin queue renders a reporter's words verbatim, and a plausible-sounding fake bug
 * ("users cannot download") sitting in a dev queue is indistinguishable from a real one
 * unless the row says it is a test.
 */
export const issueReports = pgTable(
	"issue_reports",
	{
		id: serial("id").primaryKey(),
		/** What went wrong, in the reporter's own summary of it. Required, never blank. */
		summary: text("summary").notNull(),
		/** The reporter's fuller description of the problem. Required, never blank. */
		details: text("details").notNull(),
		/**
		 * Where it happened, exactly as typed — a full URL, or a description of the page.
		 * Not validated against any route list on purpose: what they told us is the record,
		 * and our parsing of it would be a derivation that can be wrong.
		 */
		pageUrl: text("page_url").notNull().default(""),
		/**
		 * Where to write back, if they want an answer. Empty means none given. No account
		 * is required to file, so this may be the only way to reach the reporter.
		 */
		reporterEmail: text("reporter_email").notNull().default(""),
		/** Set only when the reporter happened to be signed in. Usually null. */
		reporterId: integer("reporter_id").references(() => users.id, { onDelete: "set null" }),
		status: text("status").notNull().default("open"), // open | ingested
		/**
		 * The admin account that marked it ingested. Null on an open report, and never
		 * deleted with the account — a record of who triaged a report outlives the account.
		 */
		ingestedBy: integer("ingested_by").references(() => adminAccounts.id, {
			onDelete: "set null",
		}),
		/** When it was marked ingested. Null on an open report. */
		ingestedAt: timestamp("ingested_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The console queue reads open-first, newest-first.
		index("idx_issue_reports_status").on(table.status, table.createdAt),
		// A reporter's row is findable by the account that filed it.
		index("idx_issue_reports_reporter").on(table.reporterId),
	],
);

export const issueReportsRelations = relations(issueReports, ({ one }) => ({
	reporter: one(users, { fields: [issueReports.reporterId], references: [users.id] }),
}));

// org — operational telemetry about Anthers' own infrastructure, never a creator's anything,
// the same classification `resource_snapshots` carries. An error event describes a defect in
// Anthers' own code paths; the stack frames that reach it may quote user content in a message
// string, but the row's subject is the defect, not the person.
/**
 * One deduplicated error issue — the stored half of the hand-rolled error tracker, and the
 * reason error data stays inside the database the Privacy Policy already governs rather than
 * becoming a third party's event stream (the tooling decision of 2026-10-06).
 *
 * **A row is an issue, not an occurrence.** Every capture of the same defect — same
 * normalized message, same top frames, same `source` — finds its row by fingerprint and
 * increments `count`, so a bug recurring ten thousand times is one row with a big count
 * rather than ten thousand rows never read. `sampleContext` carries the environment of the
 * last capture (route, method, release, user-agent for a browser event), overwritten per
 * occurrence rather than historized: the occcurrence history is the count, and anything
 * richer is the Admin module's future work, not this table's.
 *
 * 🚨 **The ingest never 500s.** `POST /api/errors/browser` is the one unauthenticated write
 * surface in this design, so it answers fast, refuses junk, and drops silently under
 * pressure — a failed error capture must never become the error that pages. The API-side
 * capture runs in the `app.onError` handler and is allowed to log-and-continue on failure,
 * since that error is happening anyway.
 */
export const errorEvents = pgTable(
	"error_events",
	{
		id: serial("id").primaryKey(),
		/**
		 * SHA-256 of source + normalized message + top frame function names — the identity
		 * the tracker dedupes on. Namespaced by `source` as part of the hash input, so an
		 * API error and a browser error describing the same defect stay separate rows.
		 */
		fingerprint: text("fingerprint").notNull().unique(),
		/** Where the error was caught: `api` (server onError) or `browser` (client beacon). */
		source: text("source").notNull(),
		/** The normalized message, capped. Normalization strips per-request variation. */
		message: text("message").notNull(),
		/**
		 * The top stack frames, capped at 10, as JSON — raw frames for browser events
		 * (minified, symbolication deferred to the Admin module) and readable ones for the API.
		 */
		topFrames: text("top_frames").notNull().default(""),
		/** Occurrences folded into this row. One per capture after the first. */
		count: integer("count").notNull().default(1),
		/** First capture — when the defect was born, and the release it was born into. */
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
		/** Last capture — whether a counted row is still happening. */
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
		/** The release the error was last seen in, for the "our last deploy broke things" read. */
		release: text("release").notNull().default(""),
		/** Environment of the last capture: route, method, userAgent, and the redacted URL. */
		sampleContext: jsonb("sample_context"),
		/**
		 * When an operational alert fired for this fingerprint. Null never alerted; a value
		 * is the "told once, then only on resurface" record the noisy-channel rule costs.
		 */
		alertSentAt: timestamp("alert_sent_at", { withTimezone: true }),
	},
	(table) => [
		// The operator's views: still-happening first, and first-seen for the "shipped broken" read.
		index("idx_error_events_last_seen").on(table.lastSeenAt),
		index("idx_error_events_first_seen").on(table.firstSeenAt),
	],
);
