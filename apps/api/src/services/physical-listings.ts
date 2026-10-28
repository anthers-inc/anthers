// SPDX-License-Identifier: Apache-2.0
/**
 * Physical listings — the one writer of `work_physical_listings`, and the validation a creator's
 * answer has to survive before a stranger's money depends on it.
 *
 * A listing is four answers: what shipping costs, how long the good takes to leave, what
 * it is for tax, and what choices the buyer makes. Each is checked here rather than at the
 * surface, because the same table is read by the quote, the checkout and the order, and a
 * value that only one of them validates is a value the other two will trust.
 *
 * 🚨 **Shipping is per order and free is a real answer.** A creator who builds shipping
 * into the price sets `0.00`, and that must read as a stated fact rather than as missing
 * data — the difference between "I charge nothing to ship" and "nobody has filled this in"
 * is the difference between a sale and a broken checkout.
 *
 * ⚠️ **Options are validated as a shape, not against a vocabulary.** A creator may offer
 * "Scent" as readily as "Size" here, so the checks are structural: bounded counts, unique
 * names, unique labels, and a stock that is either a non-negative integer or null for
 * unlimited. A vocabulary would be this module guessing at what people make.
 */
import { db } from "@anthers/db/client";
import { type PhysicalOption, workPhysicalListings } from "@anthers/db/schema";
import { isPhysicalTaxCategory, type PhysicalTaxCategory } from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { clampHandlingDays } from "./shipments.js";

/** What one listing may carry. Small bounds, deliberately: a picker is not a catalog. */
export const LISTING_LIMITS = {
	maxOptions: 3,
	maxValuesPerOption: 10,
	maxLabelChars: 40,
	maxStock: 1_000_000,
	maxShippingDollars: "1000.00",
} as const;

export interface PhysicalListing {
	shippingPrice: string;
	handlingBusinessDays: number;
	taxCategory: PhysicalTaxCategory;
	options: PhysicalOption[];
}

export type ListingProblem = { field: string; message: string };

export type ListingValidation =
	| { ok: true; value: PhysicalListing }
	| { ok: false; problems: ListingProblem[] };

/** An unset listing's shape — the defaults a Work carries before anybody has answered. */
export const DEFAULT_LISTING: PhysicalListing = {
	shippingPrice: "0.00",
	handlingBusinessDays: 3,
	taxCategory: "general",
	options: [],
};

const SHIPPING_SHAPE = /^\d{1,4}(\.\d{1,2})?$/;

function clean(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Check a creator's answers and normalize what survives.
 *
 * Every failure is collected rather than thrown on the first, because a form that reports
 * one problem per submit makes a creator hunt for the rest.
 */
export function validateListing(input: {
	shippingPrice?: unknown;
	handlingBusinessDays?: unknown;
	taxCategory?: unknown;
	options?: unknown;
}): ListingValidation {
	const problems: ListingProblem[] = [];

	const rawPrice = String(input.shippingPrice ?? "").trim();
	let shippingPrice = "0.00";
	if (!SHIPPING_SHAPE.test(rawPrice)) {
		problems.push({
			field: "shippingPrice",
			message: "Enter a shipping price like 4.95, or 0 for free.",
		});
	} else if (new Decimal(rawPrice).gt(new Decimal(LISTING_LIMITS.maxShippingDollars))) {
		problems.push({
			field: "shippingPrice",
			message: "That shipping price is higher than we can charge.",
		});
	} else {
		shippingPrice = new Decimal(rawPrice).toFixed(2);
	}

	const handling = Number(input.handlingBusinessDays);
	if (!Number.isFinite(handling)) {
		problems.push({
			field: "handlingBusinessDays",
			message: "Say how many business days it takes to send.",
		});
	}
	const handlingBusinessDays = clampHandlingDays(handling);

	const category = clean(input.taxCategory) || "general";
	if (!isPhysicalTaxCategory(category)) {
		problems.push({ field: "taxCategory", message: "Choose what kind of good this is." });
	}

	const options: PhysicalOption[] = [];
	const rawOptions = Array.isArray(input.options) ? input.options : [];
	if (rawOptions.length > LISTING_LIMITS.maxOptions) {
		problems.push({
			field: "options",
			message: `A good can offer up to ${LISTING_LIMITS.maxOptions} choices.`,
		});
	}
	const seenNames = new Set<string>();
	for (const raw of rawOptions.slice(0, LISTING_LIMITS.maxOptions)) {
		const source = (raw ?? {}) as { name?: unknown; values?: unknown };
		const name = clean(source.name);
		if (!name || name.length > LISTING_LIMITS.maxLabelChars) {
			problems.push({ field: "options", message: "Each choice needs a name of a few words." });
			continue;
		}
		if (seenNames.has(name.toLowerCase())) {
			problems.push({ field: "options", message: "Two choices carry the same name." });
			continue;
		}
		seenNames.add(name.toLowerCase());

		const rawValues = Array.isArray(source.values) ? source.values : [];
		if (rawValues.length === 0) {
			problems.push({ field: "options", message: `“${name}” has no options to pick from.` });
			continue;
		}
		if (rawValues.length > LISTING_LIMITS.maxValuesPerOption) {
			problems.push({
				field: "options",
				message: `“${name}” offers more than ${LISTING_LIMITS.maxValuesPerOption} values.`,
			});
			continue;
		}
		const seenLabels = new Set<string>();
		const values: PhysicalOption["values"] = [];
		for (const rawValue of rawValues) {
			const v = (rawValue ?? {}) as { label?: unknown; stock?: unknown };
			const label = clean(v.label);
			if (!label || label.length > LISTING_LIMITS.maxLabelChars) {
				problems.push({ field: "options", message: `A value under “${name}” needs a name.` });
				continue;
			}
			if (seenLabels.has(label.toLowerCase())) {
				problems.push({ field: "options", message: `“${name}” lists “${label}” twice.` });
				continue;
			}
			seenLabels.add(label.toLowerCase());
			let stock: number | null = null;
			if (v.stock != null && v.stock !== "") {
				const n = Number(v.stock);
				if (!Number.isInteger(n) || n < 0 || n > LISTING_LIMITS.maxStock) {
					problems.push({
						field: "options",
						message: `“${label}” needs a whole number left, or blank for unlimited.`,
					});
					continue;
				}
				stock = n;
			}
			values.push({ label, stock });
		}
		options.push({ name, values });
	}

	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		value: {
			shippingPrice,
			handlingBusinessDays,
			taxCategory: category as PhysicalTaxCategory,
			options,
		},
	};
}

/** The listing behind a Work, or the defaults when nobody has set one up yet. */
export async function physicalListingFor(workId: number): Promise<PhysicalListing> {
	const [row] = await db
		.select()
		.from(workPhysicalListings)
		.where(eq(workPhysicalListings.workId, workId))
		.limit(1);
	if (!row) return { ...DEFAULT_LISTING, options: [] };
	return {
		shippingPrice: row.shippingPrice,
		handlingBusinessDays: row.handlingBusinessDays,
		taxCategory: row.taxCategory as PhysicalTaxCategory,
		options: row.options ?? [],
	};
}

/**
 * Save a creator's answers, replacing whatever was there.
 *
 * Upsert rather than create-then-update: a listing has no meaningful "not yet created"
 * state, since a good is sellable the moment its Work is released and a creator may save
 * the same form twice on a slow connection.
 */
export async function savePhysicalListing(
	workId: number,
	input: Parameters<typeof validateListing>[0],
	now: Date = new Date(),
): Promise<{ ok: true; listing: PhysicalListing } | { ok: false; problems: ListingProblem[] }> {
	const checked = validateListing(input);
	if (!checked.ok) return checked;
	const value = checked.value;
	await db
		.insert(workPhysicalListings)
		.values({
			workId,
			shippingPrice: value.shippingPrice,
			handlingBusinessDays: value.handlingBusinessDays,
			taxCategory: value.taxCategory,
			options: value.options,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: workPhysicalListings.workId,
			set: {
				shippingPrice: value.shippingPrice,
				handlingBusinessDays: value.handlingBusinessDays,
				taxCategory: value.taxCategory,
				options: value.options,
				updatedAt: now,
			},
		});
	return { ok: true, listing: value };
}
