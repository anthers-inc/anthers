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
import { index, integer, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";
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
