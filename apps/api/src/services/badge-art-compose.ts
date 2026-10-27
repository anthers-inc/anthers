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
	isBadgeComposeParams,
} from "@anthers/shared/badge-art";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { downloadSvg, type NounIcon } from "../lib/noun/client";
import { composeBadgeSvg, normalizeToRecolorable } from "../lib/noun/compose-svg";
import { breakerAllows, checkBudget, recordSpend, type SpendVerdict } from "./noun-budget.js";
import { scanInlineUpload } from "./safety-scan.js";
import { storage } from "./storage/index.js";

/** Why a composition declined, so a route can answer structurally rather than by message. */
export type ComposeRefusal =
	| "not_found"
	| "not_recomposable"
	| "quarantined"
	| "budget_exhausted"
	| "breaker_open";

export interface ComposeOutcome {
	ok: boolean;
	/** True when the fingerprint matched and nothing was spent. */
	unchanged?: boolean;
	/** The storage key, for the route's response — never sent to a client raw. */
	artKey?: string;
	error?: string;
	code?: ComposeRefusal;
	/** The budget reading that refused, for the route's structured answer. */
	budget?: SpendVerdict;
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
	if (!badge) return { ok: false, code: "not_found", error: "Badge not found" };

	const fingerprint = badgeComposeFingerprint({
		nounIconId: String(icon.id),
		...placement,
	});
	if (badge.artFingerprint === fingerprint && badge.artKey) {
		return { ok: true, unchanged: true, artKey: badge.artKey };
	}

	// 🚨 **The spend guards sit AFTER dedupe and BEFORE the vendor call**, and that order is
	// the whole point on both sides: an unchanged save is free even when the day's budget is
	// spent, and a new composition never reaches the vendor once the budget or the key-wide
	// breaker has declined. Composition is an icon call by the vendor's own definition — a
	// request carrying an icon id — so it draws on the same counter a style match does.
	const verdict = await checkBudget(creatorId, "icon");
	const breakerOpen = !(await breakerAllows("icon"));
	if (!verdict.ok || breakerOpen) {
		return {
			ok: false,
			code: breakerOpen ? "breaker_open" : "budget_exhausted",
			budget: verdict,
			error: breakerOpen
				? "The Noun Project spend cap is close, so new emblems are paused."
				: "Today's emblem budget is spent, so new emblems are paused.",
		};
	}

	// The icon call happens here or not at all: past this point every failure leaves the
	// Badge's previous art (if any) untouched, so a failed compose is never a lost Badge.
	const svg = await downloadSvg(icon.id);
	// The call was made and paid for, whatever happens to the answer below — so the counter
	// records it here, not after a composition that might be refused by the scan.
	await recordSpend(creatorId, "icon");
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
		// The composed bytes are in hand — scanned from them rather than read back out of
		// storage, the same shape the upload routes carry.
		const outcome = await scanInlineUpload(
			key,
			{
				uploaderId: creatorId,
				objectKind: "badge",
			},
			png,
		);
		if (outcome.quarantine) {
			// The object is held and the Badge's art is left unchanged — the same answer
			// the upload route gives, because a scan finding is not this module's to
			// adjudicate.
			return {
				ok: false,
				code: "quarantined",
				error: "This emblem was held by the safety scan and cannot be used.",
			};
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
				artEmblemColor: placement.emblemColor,
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

/**
 * Rebuild a composed Badge's art onto a new shape or field color, reusing the stored emblem.
 *
 * ⭐ **This is the path that makes a composed Badge editable.** A composition bakes the
 * shape, the field and the edging into its PNG, so changing either one used to mean picking
 * a new emblem — the Badge Maker refused the save rather than writing columns the image did
 * not carry. Everything else the recomposition reads was already stored: the vendor icon id
 * and the credit in `badge_art_provenance`, and the placement plus the emblem color on the
 * `badges` row. The vector is fetched again because the vendor's license permits no SVG
 * cache; the composed PNG and the provenance row are the only artifacts, exactly as on a
 * first composition.
 *
 * 🚨 **It delegates to `composeBadgeArt` rather than repeating it**, so ownership, the spend
 * guards, the inline scan, the "a failed compose leaves the previous art untouched" rule and
 * the fingerprint dedupe all stay in one place. An unchanged shape and field therefore
 * dedupes and spends nothing, which is what makes a save that only touched the name free.
 *
 * ⚠️ **A row composed before `art_emblem_color` existed may have no recoverable color.**
 * Such a row is not recomposable and keeps the Badge Maker's old refusal; inventing a
 * foreground color would change the art the creator chose.
 */
export async function recomposeBadgeArt(input: {
	creatorId: number;
	badgeId: number;
	shape: string;
	fieldColor: string;
}): Promise<ComposeOutcome> {
	const { creatorId, badgeId, shape, fieldColor } = input;

	const [badge] = await db
		.select()
		.from(badges)
		.where(and(eq(badges.id, badgeId), eq(badges.creatorId, creatorId)))
		.limit(1);
	if (!badge) return { ok: false, code: "not_found", error: "Badge not found" };

	const [provenance] = await db
		.select()
		.from(badgeArtProvenance)
		.where(eq(badgeArtProvenance.badgeId, badgeId))
		.limit(1);

	// 🚨 **A partial placement is not recomposable, and `Number(null)` is zero** — which
	// would otherwise pass a finite-number check and compose art at a scale the placement
	// bounds forbid. The columns are stated together or not at all, so a null in any of them
	// means this row has no composition to rebuild.
	if (
		!badge.artKey ||
		badge.artFingerprint === null ||
		badge.artEmblemColor === null ||
		badge.artEmblemScale === null ||
		badge.artEmblemOffsetX === null ||
		badge.artEmblemOffsetY === null ||
		!provenance
	) {
		return {
			ok: false,
			code: "not_recomposable",
			error: "This Badge's emblem cannot be rebuilt. Find or upload a new one.",
		};
	}

	// The stored provenance IS the vendor's search-shaped icon fields, so the compose path
	// writes the same artist, term and license back — the credit follows the same emblem
	// rather than a fresh search that happened to match.
	const icon: NounIcon = {
		id: provenance.nounIconId,
		term: provenance.term ?? undefined,
		attribution: provenance.attribution,
		license_description: provenance.licenseDescription,
		creator: {
			name: provenance.artistName,
			permalink: provenance.artistPermalink ?? undefined,
		},
	};

	const placement: BadgeComposeParams = {
		shape,
		fieldColor,
		emblemColor: badge.artEmblemColor,
		scale: Number(badge.artEmblemScale),
		offsetX: Number(badge.artEmblemOffsetX),
		offsetY: Number(badge.artEmblemOffsetY),
	};
	// The same bounds the compose route validates a client's placement against, because a
	// stored value written by an older build is not automatically in them.
	if (!isBadgeComposeParams(placement)) {
		return {
			ok: false,
			code: "not_recomposable",
			error: "This Badge's emblem cannot be rebuilt. Find or upload a new one.",
		};
	}

	return composeBadgeArt({ creatorId, badgeId, icon, placement });
}
