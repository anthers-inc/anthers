// SPDX-License-Identifier: Apache-2.0
/**
 * The shipment clocks and the readings a surface takes of them.
 *
 * These are pure: a date in, a date or a state out. The database transitions
 * (`markShipped`, `markDelivered`, the fallback sweep) are exercised where they are first
 * driven, by the surface that marks an order shipped — this file pins the arithmetic that
 * every one of them rests on, which is the part a rounding or a timezone change would
 * quietly break.
 *
 * 🚨 **The weekend case is the one that matters.** A ship-by date computed in calendar
 * days instead of business days hands a creator a deadline two days earlier than the
 * product promises on a Thursday order, and nothing in a rendered page would look wrong.
 */
import { describe, expect, it } from "bun:test";
import type { shipments } from "@anthers/db/schema";
import {
	addBusinessDays,
	clampHandlingDays,
	isOverdue,
	isReleaseEligible,
	normalizeCarrier,
	shipmentState,
	trackingUrlFor,
} from "../services/shipments.js";

type Shipment = typeof shipments.$inferSelect;

const at = (iso: string) => new Date(iso);

/** A shipment row with only the fields a reading touches. */
function row(overrides: Partial<Shipment> = {}): Shipment {
	return {
		id: 1,
		purchaseId: 10,
		carrier: null,
		carrierName: null,
		trackingNumber: null,
		trackingUrl: null,
		handlingBusinessDays: 3,
		shipByAt: at("2026-10-26T12:00:00Z"),
		shippedAt: null,
		deliveredAt: null,
		deliverySource: null,
		complaintWindowEndsAt: null,
		events: [],
		createdAt: at("2026-10-23T12:00:00Z"),
		updatedAt: at("2026-10-23T12:00:00Z"),
		...overrides,
	} as Shipment;
}

describe("business-day arithmetic", () => {
	it("skips the weekend", () => {
		// Friday 2026-10-23 + 1 business day lands on Monday the 26th, not Saturday.
		expect(addBusinessDays(at("2026-10-23T09:00:00Z"), 1).toISOString()).toBe(
			"2026-10-26T09:00:00.000Z",
		);
		// + 3 from Friday is Wednesday, crossing one weekend.
		expect(addBusinessDays(at("2026-10-23T09:00:00Z"), 3).toISOString()).toBe(
			"2026-10-28T09:00:00.000Z",
		);
	});

	it("leaves a zero-day handling time on the day itself", () => {
		expect(addBusinessDays(at("2026-10-26T09:00:00Z"), 0).toISOString()).toBe(
			"2026-10-26T09:00:00.000Z",
		);
	});

	it("does not mutate the date it was given", () => {
		const from = at("2026-10-23T09:00:00Z");
		addBusinessDays(from, 5);
		expect(from.toISOString()).toBe("2026-10-23T09:00:00.000Z");
	});

	it("clamps a handling time into the offered range", () => {
		expect(clampHandlingDays(null)).toBe(3);
		expect(clampHandlingDays(undefined)).toBe(3);
		expect(clampHandlingDays(0)).toBe(1);
		expect(clampHandlingDays(99)).toBe(10);
		expect(clampHandlingDays(5)).toBe(5);
	});
});

describe("carriers and their links", () => {
	it("normalizes what a creator typed", () => {
		expect(normalizeCarrier("USPS")).toBe("usps");
		expect(normalizeCarrier("United States Postal Service")).toBe("usps");
		expect(normalizeCarrier("ups")).toBe("ups");
		expect(normalizeCarrier("FedEx Ground")).toBe("fedex");
		expect(normalizeCarrier("DHL Express")).toBe("dhl");
		expect(normalizeCarrier("Royal Mail")).toBe("other");
		expect(normalizeCarrier(null)).toBe("other");
	});

	it("builds a link for a carrier it knows and none for one it does not", () => {
		expect(trackingUrlFor("usps", "9400 1118 9995 5555 5555 55")).toContain("tools.usps.com");
		// The number is encoded, so a space never breaks the parameter.
		expect(trackingUrlFor("usps", "9400 1118")).toContain("9400%201118");
		expect(trackingUrlFor("ups", "1Z999AA10123456784")).toContain("tracknum=1Z999AA10123456784");
		expect(trackingUrlFor("other", "ABC123")).toBeNull();
		expect(trackingUrlFor("usps", "   ")).toBeNull();
	});
});

describe("the state a surface reads", () => {
	const now = at("2026-11-01T00:00:00Z");

	it("is awaiting shipment until something is recorded", () => {
		expect(shipmentState(row(), now)).toBe("awaiting_shipment");
	});

	it("is in transit once shipped and not delivered", () => {
		expect(shipmentState(row({ shippedAt: at("2026-10-27T00:00:00Z") }), now)).toBe("in_transit");
	});

	it("is delivered while the complaint window is open and closed after it", () => {
		const delivered = row({
			shippedAt: at("2026-10-27T00:00:00Z"),
			deliveredAt: at("2026-10-29T00:00:00Z"),
			complaintWindowEndsAt: at("2026-11-05T00:00:00Z"),
		});
		expect(shipmentState(delivered, now)).toBe("delivered");
		expect(shipmentState(delivered, at("2026-11-05T00:00:01Z"))).toBe("window_closed");
	});

	it("calls an order overdue only while it has not shipped", () => {
		expect(isOverdue(row(), now)).toBe(true);
		expect(isOverdue(row({ shippedAt: at("2026-10-30T00:00:00Z") }), now)).toBe(false);
		// A late shipment that eventually left is not overdue; it is shipped.
		expect(
			isOverdue(
				row({ shippedAt: at("2026-10-30T00:00:00Z"), shipByAt: at("2026-10-26T00:00:00Z") }),
				now,
			),
		).toBe(false);
	});
});

describe("when a creator's share may be released", () => {
	const now = at("2026-11-01T00:00:00Z");

	it("refuses a shipment that has not landed or has no window", () => {
		expect(isReleaseEligible(null, now)).toBe(false);
		expect(isReleaseEligible(row(), now)).toBe(false);
		expect(isReleaseEligible(row({ shippedAt: at("2026-10-27T00:00:00Z") }), now)).toBe(false);
	});

	it("releases only after the window it stamped has passed", () => {
		const delivered = row({
			shippedAt: at("2026-10-27T00:00:00Z"),
			deliveredAt: at("2026-10-29T00:00:00Z"),
			complaintWindowEndsAt: at("2026-11-05T00:00:00Z"),
		});
		expect(isReleaseEligible(delivered, now)).toBe(false);
		expect(isReleaseEligible(delivered, at("2026-11-05T00:00:00Z"))).toBe(true);
	});
});
