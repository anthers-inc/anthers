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
import { index, integer, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";

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