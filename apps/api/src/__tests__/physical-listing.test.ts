// SPDX-License-Identifier: Apache-2.0
/**
 * What a creator's physical listing may carry, and what it may not.
 *
 * The same table is read by a quote, a checkout and an order, so the validation lives here
 * rather than at whichever surface happens to save it — a value only one of them checks is
 * a value the other two trust. These are pure: an object in, a normalized object or a list
 * of problems out, with no database in the way.
 */
import { describe, expect, it } from "bun:test";
import { validateListing } from "../services/physical-listings.js";

const base = {
	shippingPrice: "4.95",
	handlingBusinessDays: 3,
	taxCategory: "general",
	options: [],
	images: [],
};

describe("shipping price", () => {
	it("accepts a plain price and normalizes it to cents", () => {
		const r = validateListing({ ...base, shippingPrice: "4.9" });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.shippingPrice).toBe("4.90");
	});

	it("treats zero as a stated fact rather than missing data", () => {
		const r = validateListing({ ...base, shippingPrice: "0" });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.shippingPrice).toBe("0.00");
	});

	it("refuses anything that is not a price", () => {
		for (const bad of ["", "four", "-1", "4.955", "1,000"]) {
			const r = validateListing({ ...base, shippingPrice: bad });
			expect(r.ok).toBe(false);
		}
	});

	it("refuses a price above what we would charge", () => {
		expect(validateListing({ ...base, shippingPrice: "1000.01" }).ok).toBe(false);
		expect(validateListing({ ...base, shippingPrice: "1000.00" }).ok).toBe(true);
	});
});

describe("handling time and tax category", () => {
	it("clamps a handling time into the offered range", () => {
		for (const [given, expected] of [
			[1, 1],
			[0, 1],
			[99, 10],
			[5, 5],
		] as const) {
			const r = validateListing({ ...base, handlingBusinessDays: given });
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value.handlingBusinessDays).toBe(expected);
		}
	});

	it("defaults the category and refuses one nobody priced", () => {
		const blank = validateListing({ ...base, taxCategory: "" });
		expect(blank.ok).toBe(true);
		if (blank.ok) expect(blank.value.taxCategory).toBe("general");

		expect(validateListing({ ...base, taxCategory: "livestock" }).ok).toBe(false);
	});
});

describe("options", () => {
	const withOptions = (options: unknown) => validateListing({ ...base, options });

	it("keeps a well-formed choice in the creator's order", () => {
		const r = withOptions([
			{
				name: "Size",
				values: [
					{ label: "M", stock: 4 },
					{ label: "L", stock: null },
				],
			},
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.options[0].name).toBe("Size");
			expect(r.value.options[0].values.map((v) => v.label)).toEqual(["M", "L"]);
			expect(r.value.options[0].values[1].stock).toBeNull();
		}
	});

	it("reads a blank stock as unlimited rather than zero", () => {
		const r = withOptions([{ name: "Scent", values: [{ label: "Cedar", stock: "" }] }]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.options[0].values[0].stock).toBeNull();
	});

	it("refuses a choice with no values", () => {
		expect(withOptions([{ name: "Size", values: [] }]).ok).toBe(false);
	});

	it("refuses duplicate names and duplicate values", () => {
		expect(
			withOptions([
				{ name: "Size", values: [{ label: "M" }] },
				{ name: "size", values: [{ label: "L" }] },
			]).ok,
		).toBe(false);
		expect(withOptions([{ name: "Size", values: [{ label: "M" }, { label: "m" }] }]).ok).toBe(
			false,
		);
	});

	it("refuses a stock that is not a whole count", () => {
		for (const bad of [-1, 1.5, "many"]) {
			expect(withOptions([{ name: "Size", values: [{ label: "M", stock: bad }] }]).ok).toBe(false);
		}
	});

	it("bounds how many choices and values a picker may carry", () => {
		const four = Array.from({ length: 4 }, (_, i) => ({
			name: `Choice ${i}`,
			values: [{ label: "A" }],
		}));
		expect(withOptions(four).ok).toBe(false);

		const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `V${i}` }));
		expect(withOptions([{ name: "Size", values: eleven }]).ok).toBe(false);
	});

	it("refuses an unnamed choice or value", () => {
		expect(withOptions([{ name: "  ", values: [{ label: "M" }] }]).ok).toBe(false);
		expect(withOptions([{ name: "Size", values: [{ label: "" }] }]).ok).toBe(false);
	});
});

describe("pictures", () => {
	const withImages = (images: unknown) => validateListing({ ...base, images });

	it("keeps an ordered gallery with its descriptions", () => {
		const r = withImages([
			{ key: "creators/1/photo-a.jpg", alt: "The mug from the front" },
			{ key: "creators/1/photo-b.jpg", alt: "" },
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.images).toEqual([
				{ key: "creators/1/photo-a.jpg", alt: "The mug from the front" },
				{ key: "creators/1/photo-b.jpg", alt: "" },
			]);
		}
	});

	it("refuses a blank key and a picture twice", () => {
		expect(withImages([{ key: "", alt: "A mug" }]).ok).toBe(false);
		expect(
			withImages([
				{ key: "creators/1/photo.jpg", alt: "A mug" },
				{ key: "creators/1/photo.jpg", alt: "The same mug" },
			]).ok,
		).toBe(false);
	});

	it("bounds the gallery and each description", () => {
		const nine = Array.from({ length: 9 }, (_, i) => ({ key: `creators/1/${i}.jpg`, alt: "" }));
		expect(withImages(nine).ok).toBe(false);
		expect(withImages([{ key: "creators/1/a.jpg", alt: "x".repeat(301) }]).ok).toBe(false);
	});
});
