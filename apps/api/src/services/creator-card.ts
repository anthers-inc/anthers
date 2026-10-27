// SPDX-License-Identifier: Apache-2.0
/**
 * The card a shared profile is unfurled with.
 *
 * A Work's card image is its creator-authored thumbnail, so a profile's counterpart is the
 * two pictures its creator already chose: the banner, framed at 3:1 for the page's own band,
 * and the portrait the page shows in a circle. This module composes them into the 1200×630
 * shape every link unfurler crops to, laid out the way the profile page itself is — the
 * banner across the top, the portrait overhanging its lower edge.
 *
 * ⚠️ **Why not just hand the crawler the avatar?** That is what the card read did until this
 * module, and it reads as the site's own logo whenever a creator's portrait is their mark —
 * Anthers' own account is the standing example. A square portrait also has the wrong aspect
 * for the card, so the unfurler crops it to a window nobody chose.
 *
 * ⚠️ **The banner is contained at its own 3:1 rather than cover-cropped to the card's 1.9:1.**
 * Cropping a banner to the card throws away a third of its width and, on a banner that is
 * mostly a wordmark, cuts the wordmark in half — the profile's own art then reads as a
 * mistake. The card is wide enough to give the banner its full width and keep the lower band
 * as the cream field the portrait and the mark sit on.
 *
 * ⭐ **The card carries no type.** The unfurler prints the name and the bio directly beneath
 * the image, and a card that repeated them would spend the one wide space it gets saying
 * everything twice. What the image adds is the two things type cannot: the creator's own art
 * and the platform's mark for provenance.
 *
 * The composition degrades rather than fails: no banner leaves the cream ground, no portrait
 * leaves the art and the mark, and the caller still has the site card to fall back to if the
 * whole render throws.
 */

import sharp from "sharp";

/** The card's own dimensions — the box every link unfurler crops an image into. */
export const CREATOR_CARD_WIDTH = 1200;
export const CREATOR_CARD_HEIGHT = 630;

/**
 * The palette, sampled from the brand's own artwork rather than restated from a token: the
 * cream is `og-card.png`'s ground, so a profile card and the site's own card agree on it.
 */
const CREAM = "#F5F3E3";
const PEACH = "#F9C370";

/** The banner's band — the card's full width at the banner's own 3:1. */
const BANNER_HEIGHT = CREATOR_CARD_WIDTH / 3;

/** The portrait's diameter, the ring drawn around it, and the card's own inset. */
const PORTRAIT = 168;
const RING = 6;
const MARGIN = 64;

/**
 * A creator with no banner gets a larger portrait centered in the card's field instead.
 *
 * The banner carries a band's worth of the composition, and a portrait alone at the same
 * small size leaves a card that reads as unfinished rather than as quiet.
 */
const PORTRAIT_ALONE = 300;

/** The wordmark's rendered height. Its width comes from the committed lockup's aspect. */
const WORDMARK_HEIGHT = 56;

/** The two pictures a profile's card is composed from, or null where the creator set none. */
export interface CreatorCardArt {
	banner: Uint8Array | null;
	portrait: Uint8Array | null;
}

/**
 * The lockup, resolved through the brand package rather than from a path relative to this
 * file: `@anthers/brand` is a workspace dependency of the API and ships in its image, so the
 * layout of that package stays the package's business.
 *
 * `light` is the dark-ink lockup, drawn for light grounds — which is where this card puts it.
 */
const lockupPath = () =>
	Bun.resolveSync("@anthers/brand/logo/web/lockup-oneline-light.png", import.meta.dir);

/** A circular window, used to punch a portrait's square into a disc. */
function portraitMask(size: number): Buffer {
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
			<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/>
		</svg>`,
	);
}

/** The ring around a portrait, in whatever color reads against the ground beneath it. */
function portraitRing(size: number, color: string): Buffer {
	const box = size + RING * 2;
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}">
			<circle cx="${box / 2}" cy="${box / 2}" r="${size / 2 + RING / 2}"
				fill="none" stroke="${color}" stroke-width="${RING}"/>
		</svg>`,
	);
}

/**
 * Compose one creator's card.
 *
 * The portrait's center sits on the banner's lower edge when there is a banner, so it
 * overhangs the way the profile page's does. With no banner it becomes the card's whole
 * subject, larger and centered in the cream field, with the peach ring standing in for the
 * seam the banner would have given it.
 */
export async function composeCreatorCard(art: CreatorCardArt): Promise<Buffer> {
	const layers: sharp.OverlayOptions[] = [];

	if (art.banner) {
		layers.push({
			input: await sharp(art.banner, { failOn: "none" })
				.rotate()
				.resize(CREATOR_CARD_WIDTH, BANNER_HEIGHT, { fit: "cover", position: "center" })
				.png()
				.toBuffer(),
			top: 0,
			left: 0,
		});
	}

	const size = art.banner ? PORTRAIT : PORTRAIT_ALONE;
	// Overhang the banner's edge, or sit above the wordmark in the portrait's own field.
	const centerX = art.banner ? MARGIN + size / 2 : CREATOR_CARD_WIDTH / 2;
	const centerY = art.banner
		? BANNER_HEIGHT
		: (CREATOR_CARD_HEIGHT - WORDMARK_HEIGHT - MARGIN) / 2 + WORDMARK_HEIGHT / 2;

	if (art.portrait) {
		layers.push({
			input: portraitRing(size, art.banner ? CREAM : PEACH),
			top: centerY - size / 2 - RING,
			left: centerX - size / 2 - RING,
		});
		layers.push({
			input: await sharp(art.portrait, { failOn: "none" })
				.rotate()
				.resize(size, size, { fit: "cover" })
				.composite([{ input: portraitMask(size), blend: "dest-in" }])
				.png()
				.toBuffer(),
			top: centerY - size / 2,
			left: centerX - size / 2,
		});
	}

	const lockup = await sharp(lockupPath()).resize({ height: WORDMARK_HEIGHT }).png().toBuffer();
	const { width = 0, height = WORDMARK_HEIGHT } = await sharp(lockup).metadata();
	layers.push({
		input: lockup,
		// Centered in the band below the banner, or kept to the card's own bottom margin when
		// the whole ground is the portrait's field.
		top: art.banner
			? BANNER_HEIGHT + (CREATOR_CARD_HEIGHT - BANNER_HEIGHT - height) / 2
			: CREATOR_CARD_HEIGHT - MARGIN - height,
		left: CREATOR_CARD_WIDTH - MARGIN - width,
	});

	return await sharp({
		create: {
			width: CREATOR_CARD_WIDTH,
			height: CREATOR_CARD_HEIGHT,
			channels: 4,
			background: CREAM,
		},
	})
		.composite(layers)
		.png({ compressionLevel: 9 })
		.toBuffer();
}
