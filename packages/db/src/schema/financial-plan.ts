// SPDX-License-Identifier: Apache-2.0
/**
 * The financial plan — the Admin Console's planning tool's tables.
 *
 * org — Anthers' own financial plan, never a creator's anything.
 *
 * 🚨 **This is the raw data host, not a cache** (Parker, 2026-10-07): the admin
 * console's Financial Plan screen edits these rows directly, public-facing
 * financial resources are generated FROM this data, and the financial
 * projections in internal docs dissolve into it. There is no upstream source and
 * no code constant to re-derive a phase from — the plan is data, owned here.
 *
 * The ledger math lives in `@anthers/shared/financial-plan` and is never
 * duplicated: a phase row holds the INPUTS (accounts, paying share, staffing
 * spend, the two shares), and every dollar figure anyone sees is computed from
 * them at read time. Edits to inputs are the tool's writes; computed outputs are
 * never stored.
 *
 * `phase` is 1-based and orders the path from here through inflection 1; the
 * phases' inputs only are stored, the computed ledger derived at read time, so a
 * dial move upstream restates every row without a migration of computed values.
 */
import {
	integer,
	pgTable,
	real,
	serial,
	smallint,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

// org — Anthers' own global plan settings: exactly one row, the shares phases default to.
export const financialPlanSettings = pgTable("financial_plan_settings", {
	id: serial("id").primaryKey(),
	/** The admin budget as a share of charitable revenue — the locked 30% ceiling. */
	adminBudgetShare: real("admin_budget_share").notNull(),
	/** The Time Pool Fund's share of the remainder after admin. */
	fundShare: real("fund_share").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// org — one phase of the plan: a scale, and the operating spend planned there.
export const financialPlanPhases = pgTable(
	"financial_plan_phases",
	{
		id: serial("id").primaryKey(),
		/** 1-based order along the plan's path. */
		phase: smallint("phase").notNull(),
		/** A short label the tool's table and the generated views show ("Launch", "Full-time"). */
		label: text("label").notNull(),
		accounts: integer("accounts").notNull(),
		/** Share of accounts giving Anthers anything, 0..1. */
		payingShare: real("paying_share").notNull(),
		/** Planned operating spend, $/mo: compensation + tooling + services. */
		staff: real("staff").notNull().default(0),
		tooling: real("tooling").notNull().default(0),
		services: real("services").notNull().default(0),
		/** Overrides of the global shares, when a phase diverges (null = use settings). */
		adminBudgetShare: real("admin_budget_share"),
		fundShare: real("fund_share"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_financial_plan_phases_phase").on(table.phase)],
);
