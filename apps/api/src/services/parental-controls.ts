// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parental controls — the database half, and the sole writer of `parental_controls`.
 *
 * The **policy** is `@anthers/shared/parental-controls`, which is pure and knows nothing about
 * a database; this module is the boundary that feeds it and the one place a pin is checked.
 * Same split as `public-access.ts` and `services/access.ts`: the rules live somewhere
 * exhaustively testable, and the I/O lives where it can be seen.
 *
 * 🚨 **The pin is the whole security model, and it is a deliberately weak one.** Four to eight
 * digits, typed often and sometimes in front of the person it restricts. What it defends
 * against is the account holder lifting their own restrictions, which is the actual threat —
 * not a stranger, who would need the session first and has better things to do with it. So the
 * hash is argon2id because a database read should be useless, and guessing is bounded by rate
 * limiting at the route rather than by the pin's own strength.
 *
 * ⚠️ **A guardian's settings never leave this account.** Nothing here writes a rating, a note
 * or an access row, and nothing here is readable by anybody but the account holder — which is
 * what keeps one household's controls out of everybody else's catalogue. The controls sit on
 * the viewer, never on the Work.
 */

import { db } from "@anthers/db/client";
import { attentionEvents, parentalControls, works } from "@anthers/db/schema";
import {
	type ConsumedSeconds,
	NO_PARENTAL_CONTROLS,
	type ParentalList,
	type ParentalPolicy,
} from "@anthers/shared/parental-controls";
import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "./auth.js";

/** Four to eight digits. Anything else is not a pin and is refused before it is hashed. */
export const PIN_PATTERN = /^\d{4,8}$/;

/** A list as stored, or the permissive default when the column has never been written. */
function listOrDefault(stored: ParentalList | null | undefined): ParentalList {
	if (!stored || !Array.isArray(stored.rules)) return { defaultAllow: true, rules: [] };
	return {
		defaultAllow: stored.defaultAllow !== false,
		rules: stored.rules
			.filter((r) => r && typeof r.key === "string")
			.map((r) => ({
				key: r.key,
				allow: r.allow !== false,
				dailySeconds:
					typeof r.dailySeconds === "number" && r.dailySeconds >= 0 ? r.dailySeconds : null,
			})),
	};
}

/**
 * The controls on an account, or none.
 *
 * 🚨 **Defaults are resolved in code rather than by column defaults**, the same discipline the
 * content preferences follow. An account with no row must read as *no controls at all* rather
 * than as a row of falses, because "there is no pin" and "there is a pin and everything is
 * permitted" are different states — the first cannot be locked out of anything and the second
 * can.
 */
export async function parentalPolicyFor(userId: number | null): Promise<ParentalPolicy> {
	if (userId == null) return NO_PARENTAL_CONTROLS;
	const [row] = await db
		.select()
		.from(parentalControls)
		.where(eq(parentalControls.userId, userId))
		.limit(1);
	if (!row) return NO_PARENTAL_CONTROLS;

	return {
		enabled: true,
		lockMaturity: row.lockMaturity,
		creators: listOrDefault(row.creators),
		types: listOrDefault(row.types),
		limits: {
			daily: row.dailySeconds ?? null,
			weekly: row.weeklySeconds ?? null,
			monthly: row.monthlySeconds ?? null,
		},
		languageFilter: row.languageFilter,
	};
}

/**
 * Whether a guardian has frozen this account's content-rating settings.
 *
 * 🚨 **Asked by the WRITER of those settings, not by a route.** The pin is a request-level
 * check and belongs where the request is, but this one is derived from the account alone — so
 * putting it at a route protects that route and nothing else, which is exactly how the lock
 * came to cover `PATCH /me/content-preferences` while `POST /me/adult-access` wrote the columns
 * that actually govern reaching the Adult rung. `services/content-preferences.ts` asks this
 * before every write it makes, so a door added later is covered by construction rather than by
 * whoever adds it remembering.
 */
export async function maturityLocked(userId: number | null): Promise<boolean> {
	const policy = await parentalPolicyFor(userId);
	return policy.enabled && policy.lockMaturity;
}

/** Whether a presented pin is the one on file. False when there is no pin at all. */
export async function pinMatches(userId: number, pin: string): Promise<boolean> {
	const [row] = await db
		.select({ pinHash: parentalControls.pinHash })
		.from(parentalControls)
		.where(eq(parentalControls.userId, userId))
		.limit(1);
	if (!row) return false;
	return verifyPassword(pin, row.pinHash);
}

export type PinRefusal = "malformed" | "wrong_pin";

/**
 * Set the pin for the first time, or change it with the old one.
 *
 * ⚠️ **There is no reset door here, and its absence is a decision rather than an omission.** A
 * "forgot your pin?" flow that mailed a link to the account's own address would hand the pin
 * to the person it restricts, since a child's account is very often reachable from the child's
 * own inbox. Recovering from a forgotten pin is a support conversation, which is slow on
 * purpose.
 */
export async function setPin(
	userId: number,
	pin: string,
	currentPin?: string,
): Promise<{ ok: true } | { refusal: PinRefusal }> {
	if (!PIN_PATTERN.test(pin)) return { refusal: "malformed" };

	const [existing] = await db
		.select({ pinHash: parentalControls.pinHash })
		.from(parentalControls)
		.where(eq(parentalControls.userId, userId))
		.limit(1);

	if (existing) {
		if (!currentPin || !(await verifyPassword(currentPin, existing.pinHash))) {
			return { refusal: "wrong_pin" };
		}
	}

	const pinHash = await hashPassword(pin);
	await db
		.insert(parentalControls)
		.values({ userId, pinHash })
		.onConflictDoUpdate({
			target: parentalControls.userId,
			set: { pinHash, updatedAt: new Date() },
		});
	return { ok: true };
}

/** What a guardian may change, all of it optional and all of it pin-gated at the route. */
export interface ParentalUpdate {
	lockMaturity?: boolean;
	creators?: ParentalList;
	types?: ParentalList;
	limits?: { daily: number | null; weekly: number | null; monthly: number | null };
	languageFilter?: boolean;
}

/** Write the policy. The caller has already checked the pin. */
export async function updateParentalControls(
	userId: number,
	input: ParentalUpdate,
): Promise<ParentalPolicy> {
	await db
		.update(parentalControls)
		.set({
			...(input.lockMaturity !== undefined ? { lockMaturity: input.lockMaturity } : {}),
			...(input.creators !== undefined ? { creators: listOrDefault(input.creators) } : {}),
			...(input.types !== undefined ? { types: listOrDefault(input.types) } : {}),
			...(input.limits !== undefined
				? {
						dailySeconds: input.limits.daily,
						weeklySeconds: input.limits.weekly,
						monthlySeconds: input.limits.monthly,
					}
				: {}),
			...(input.languageFilter !== undefined ? { languageFilter: input.languageFilter } : {}),
			updatedAt: new Date(),
		})
		.where(eq(parentalControls.userId, userId));
	return parentalPolicyFor(userId);
}

/**
 * Turn the controls off entirely, with the pin.
 *
 * Deletes the row rather than clearing its columns, because "no controls" is the absence of a
 * row and a row of falses would leave the account still holding a pin nobody remembers setting.
 */
export async function clearParentalControls(userId: number): Promise<void> {
	await db.delete(parentalControls).where(eq(parentalControls.userId, userId));
}

// ── What has been consumed ───────────────────────────────────────────────────

/** Midnight this morning, in server time — the same day boundary the panel shows. */
function dayStart(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Rolling seven and thirty days rather than calendar weeks and months. */
function daysAgo(now: Date, days: number): Date {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * How much of each window this account has spent consuming Works.
 *
 * 🚨 **This measures time spent CONSUMING, which is the only time Anthers measures.** Browsing
 * a catalogue writes no attention event and cannot honestly be counted, so a limit set here is
 * not screen time and the panel must not call it that. Naming it screen time would promise a
 * measurement that does not exist, and a guardian would find out by watching a child sit on
 * the site all evening with the limit untouched.
 *
 * ⚠️ **Every attention row counts, `public_access` or not.** The Public Access meter is about
 * what the *commons* owes a viewer; this is about how long somebody has been consuming, and an
 * hour of a Work their parent bought them is an hour either way. Filtering on the flag here
 * would let a household's whole limit be bypassed by anything that was paid for.
 */
export async function consumedSeconds(
	userId: number,
	scope: { creatorId?: number | null; workType?: string | null } = {},
	now: Date = new Date(),
): Promise<ConsumedSeconds> {
	const total = (from: Date, extra?: ReturnType<typeof eq>) =>
		db
			.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
			.from(attentionEvents)
			.where(
				and(
					eq(attentionEvents.userId, userId),
					gte(attentionEvents.createdAt, from),
					...(extra ? [extra] : []),
				),
			);

	const today = dayStart(now);
	const [day, week, month, scoped] = await Promise.all([
		total(today),
		total(daysAgo(now, 7)),
		total(daysAgo(now, 30)),
		// The scoped figure is only ever a *daily* one, because the per-key caps are daily. A
		// creator scope wins over a type scope when both are given, matching `dailyCapFor`'s
		// order — the creator rule is the more specific thing a guardian said.
		scope.creatorId != null
			? total(today, eq(attentionEvents.creatorId, scope.creatorId))
			: Promise.resolve([{ total: 0 }]),
	]);

	return {
		day: Number(day[0]?.total ?? 0),
		week: Number(week[0]?.total ?? 0),
		month: Number(month[0]?.total ?? 0),
		scopedDay: Number(scoped[0]?.total ?? 0),
	};
}

// ── Keeping blocked work out of listings ─────────────────────────────────────

/**
 * A SQL condition hiding what a guardian has blocked.
 *
 * 🚨 **A second mechanism for something the resolver already refuses, and both are needed.**
 * `resolveAccessSync` stops a blocked Work being *opened*; this stops it being *listed*, which
 * is a different promise. A shelf full of cards a child cannot click is not a protection, it
 * is an advertisement — the same reasoning that makes the maturity `hide` setting a query
 * condition rather than a client-side veil.
 *
 * ⚠️ **Built as an ALLOW-list wherever it can be**, following `maturityHiddenFrom`. A blocklist
 * in SQL lets through anything it was not told about; naming what may be seen means an
 * unrecognized value is absent instead. It errs toward showing less, which is the direction a
 * guardian's setting should fail in.
 *
 * ⭐ A creator always sees their own work, whatever a guardian set about *other* creators —
 * the same exception every other listing filter makes, and for the same reason.
 */
export function parentalHiddenFrom(
	policy: ParentalPolicy,
	viewerId: number | null,
	creatorColumn: SQL | unknown = works.creatorId,
	typeColumn: SQL | unknown = works.type,
): SQL | undefined {
	if (!policy.enabled) return undefined;

	const conditions: SQL[] = [];

	const blockedCreators = policy.creators.rules.filter((r) => !r.allow).map((r) => Number(r.key));
	const allowedCreators = policy.creators.rules.filter((r) => r.allow).map((r) => Number(r.key));
	if (policy.creators.defaultAllow) {
		const ids = blockedCreators.filter(Number.isFinite);
		if (ids.length > 0) {
			conditions.push(
				sql`${creatorColumn} NOT IN (${sql.join(
					ids.map((n) => sql`${n}`),
					sql`, `,
				)})`,
			);
		}
	} else {
		const ids = allowedCreators.filter(Number.isFinite);
		// An allowlist with nothing on it hides everything, which is what it says. `FALSE`
		// rather than an empty `IN ()`, which is a syntax error in Postgres.
		conditions.push(
			ids.length === 0
				? sql`FALSE`
				: sql`${creatorColumn} IN (${sql.join(
						ids.map((n) => sql`${n}`),
						sql`, `,
					)})`,
		);
	}

	const blockedTypes = policy.types.rules.filter((r) => !r.allow).map((r) => r.key);
	const allowedTypes = policy.types.rules.filter((r) => r.allow).map((r) => r.key);
	if (policy.types.defaultAllow) {
		if (blockedTypes.length > 0) {
			conditions.push(
				sql`${typeColumn} NOT IN (${sql.join(
					blockedTypes.map((t) => sql`${t}`),
					sql`, `,
				)})`,
			);
		}
	} else {
		conditions.push(
			allowedTypes.length === 0
				? sql`FALSE`
				: sql`${typeColumn} IN (${sql.join(
						allowedTypes.map((t) => sql`${t}`),
						sql`, `,
					)})`,
		);
	}

	if (conditions.length === 0) return undefined;
	const all = sql.join(conditions, sql` AND `);
	if (viewerId == null) return sql`(${all})`;
	return sql`((${all}) OR ${creatorColumn} = ${viewerId})`;
}

/** The policy and the listing condition that follows, in one step. */
export async function parentalVisibility(viewerId: number | null): Promise<{
	policy: ParentalPolicy;
	hidden: SQL | undefined;
}> {
	const policy = await parentalPolicyFor(viewerId);
	return { policy, hidden: parentalHiddenFrom(policy, viewerId) };
}
