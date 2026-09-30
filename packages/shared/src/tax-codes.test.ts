// SPDX-License-Identifier: Apache-2.0
/**
 * The tax-code mapping, table-tested — the posture's *What Gets Taxed* table restated as
 * assertions, one row per Work type plus the two named constants.
 *
 * 🚨 **The `null` rows are the refusal, not a gap.** A `physical` or `service` Work is not
 * sold, and a checkout path that maps one to a code would charge a buyer for something
 * nothing delivers — so those two rows are the assertions that keep the refusal honest.
 */
import { describe, expect, it } from "bun:test";
import { WORK_TYPES } from "./content.js";
import { DONATION_TAX_CODE, purchaseTaxCode, STREAMED_SUBSCRIPTION_TAX_CODE } from "./tax-codes.js";

describe("purchaseTaxCode — the What Gets Taxed table", () => {
	it("maps every Work type the model has, so a new type cannot slip past unmapped", () => {
		// WORK_TYPES is the closed union a Work's type actually carries, so this asserts the
		// mapping is total rather than trusting the switch to have been extended.
		for (const type of WORK_TYPES) {
			// `purchaseTaxCode` reads only its argument, so calling every type is exhaustive.
			const code = purchaseTaxCode(type);
			if (type === "physical" || type === "service") {
				expect(code).toBeNull();
			} else {
				expect(code, `no tax code for ${type}`).toMatch(/^txcd_\d{8}$/);
			}
		}
	});

	it("codes each Work type per the posture table", () => {
		expect(purchaseTaxCode("video")).toBe("txcd_10402000");
		expect(purchaseTaxCode("music")).toBe("txcd_10401000");
		expect(purchaseTaxCode("audio")).toBe("txcd_10401000");
		expect(purchaseTaxCode("text")).toBe("txcd_10302000");
		expect(purchaseTaxCode("ebook")).toBe("txcd_10302000");
		expect(purchaseTaxCode("comic")).toBe("txcd_10503000");
		expect(purchaseTaxCode("image")).toBe("txcd_10501000");
		// Downloaded and embedded share one code — see the tax-codes header for why.
		expect(purchaseTaxCode("game")).toBe("txcd_10201000");
		expect(purchaseTaxCode("software")).toBe("txcd_10201000");
	});

	it("refuses a physical or service Work — nothing fulfills them yet", () => {
		expect(purchaseTaxCode("physical")).toBeNull();
		expect(purchaseTaxCode("service")).toBeNull();
	});

	it("names the subscription-side codes the posture settled", () => {
		expect(DONATION_TAX_CODE).toBe("txcd_90000001");
		expect(STREAMED_SUBSCRIPTION_TAX_CODE).toBe("txcd_10402200");
	});
});
