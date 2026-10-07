// SPDX-License-Identifier: Apache-2.0
/**
 * Compose a creator Badge from a Noun Project icon — the one runtime consumer of the
 * vendor's `download` endpoint, and the module that owns the records composition writes.
 *
 * 🚨 **THE ONE OPERATION.** Fetch, recolor, size, position, compose, rasterize and
 * discard happen inside one request: the vector lives in this module's memory for the
 * length of the call and is never written to a bucket, a disk or a database — the key
 * creation flow required agreeing that the app will not cache SVG files. The ONLY
 * artifact that persists is the finished composed Badge PNG, stored through the same
 * path as uploaded art, plus the provenance row (metadata, which the vendor permits).
 *
 * 🚨 **This module is the only writer of `badge_art_provenance` and of the composition
 * columns on `badges`** — reaching around it is the bug, the same rule every `services/`
 * module carries. The vector-discard and pin-to-black rules are proved by the tests
 * beside this file rather than trusted to whoever calls next.
 *
 * The rendering mirrors `BadgeMark` in `@anthers/web-shared` — `compose-svg.ts` is its
 * server twin, written down there.
 */

import { db } from "@anthers/db/client";
import { badgeArtProvenance, badges } from "@anthers/db/schema";
import {
	BADGE_COMPOSE_PX,
	type BadgeComposeParams,
	badgeComposeFingerprint,
} from "@anthers/shared/badge-art";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { downloadSvg, type NounIcon } from "../lib/noun/client";
import { composeBadgeSvg, normalizeToRecolorable } from "../lib/noun/compose-svg";
import { scanInlineUpload } from "./safety-scan.js";
import { storage } from "./storage/index.js";

export interface ComposeOutcome {
	ok: boolean;
	/** True when the fingerprint matched and nothing was spent. */
	unchanged?: boolean;
	/** The storage key, for the route's response — never sent to a client raw. */
	artKey?: string;
	error?: string;
}

/**
 * Recompose (or first-compose) a Badge's art from a Noun Project icon.
 *
 * 🚨 **An unchanged composition spends nothing at all** — no fetch, no raster, no upload,
 * no scan, no write — because dedupe reads the fingerprint BEFORE the vendor call. Save
 * is the button people press repeatedly, and the second press must be free.
 *
 * 🚨 **The vector never leaves this function.** `downloadSvg`'s answer is consumed by
 * `normalizeToRecolorable` and `composeBadgeSvg` and is unreferenced at the `finally` —
 * no caller receives it, no test may assert on it, and no code below this module may
 * reach it.
 */
export async function composeBadgeArt(input: {
	creatorId: number;
	badgeId: number;
	icon: NounIcon;
	placement: BadgeComposeParams;
}): Promise<ComposeOutcome> {
	const { creatorId, badgeId, icon, placement } = input;

	const [badge] = await db
		.select()
		.from(badges)
		.where(and(eq(badges.id, badgeId), eq(badges.creatorId, creatorId)))
		.limit(1);
	if (!badge) return { ok: false, error: "Badge not found" };

	const fingerprint = badgeComposeFingerprint({
		nounIconId: String(icon.id),
		...placement,
	});
	if (badge.artFingerprint === fingerprint && badge.artKey) {
		return { ok: true, unchanged: true, artKey: badge.artKey };
	}

	// The icon call happens here or not at all: past this point every failure leaves the
	// Badge's previous art (if any) untouched, so a failed compose is never a lost Badge.
	const svg = await downloadSvg(icon.id);
	try {
		const { viewBox, inner } = normalizeToRecolorable(svg);
		const badgeSvg = composeBadgeSvg({ placement, viewBox, inner });
		const png = await sharp(Buffer.from(badgeSvg))
			.resize(BADGE_COMPOSE_PX, BADGE_COMPOSE_PX)
			.png()
			.toBuffer();

		// Same key layout, same private ACL, same inline scan as a creator upload: a
		// composed Badge is an image like any other once the vector is discarded, and
		// quarantine must precede visibility exactly as it does for uploads.
		const key = `creators/${creatorId}/badges/${badgeId}/${crypto.randomUUID().replace(/-/g, "")}.png`;
		await storage.upload(key, png, "image/png", "private");
		const outcome = await scanInlineUpload(key, {
			uploaderId: creatorId,
			objectKind: "badge",
		});
		if (outcome.quarantine) {
			// The object is held and the Badge's art is left unchanged — the same answer
			// the upload route gives, because a scan finding is not this module's to
			// adjudicate.
			return { ok: false, error: "This emblem was held by the safety scan and cannot be used." };
		}

		// Provenance rides along on the search response the picker already showed; the
		// upsert replaces the row, because the row describes the Badge's CURRENT art.
		const provenance = {
			nounIconId: String(icon.id),
			term: icon.term ?? null,
			artistName: icon.creator?.name ?? icon.attribution ?? "Unknown artist",
			artistPermalink: icon.creator?.permalink ?? null,
			licenseDescription: icon.license_description ?? "Unknown",
			attribution: icon.attribution ?? "",
		};
		await db
			.insert(badgeArtProvenance)
			.values({ badgeId, ...provenance })
			.onConflictDoUpdate({
				target: badgeArtProvenance.badgeId,
				set: { ...provenance, updatedAt: new Date() },
			});

		// The row points at the new object BEFORE the old one is deleted, so a failure
		// between the two leaves the Badge displaying rather than missing.
		const previousKey = badge.artKey;
		await db
			.update(badges)
			.set({
				artKey: key,
				artShape: placement.shape,
				artColor: placement.fieldColor,
				artFingerprint: fingerprint,
				artEmblemScale: String(placement.scale),
				artEmblemOffsetX: String(placement.offsetX),
				artEmblemOffsetY: String(placement.offsetY),
				updatedAt: new Date(),
			})
			.where(eq(badges.id, badgeId));
		if (previousKey && previousKey !== key) {
			await storage.delete(previousKey).catch(() => null);
		}

		return { ok: true, artKey: key };
	} finally {
		// `svg`, `badgeSvg` and `png`'s SVG form go out of scope here. Nothing in this
		// function writes the vector anywhere — the persisted artifacts are the composed
		// PNG (through `storage.upload`) and the provenance row, and nothing else.
	}
}
