// SPDX-License-Identifier: Apache-2.0
/**
 * What a creator space holds: the draft only its creator can read, and the manifest a gated
 * Work's audience can.
 *
 * ⚠️ **These are draft record shapes, not a published Lexicon.** The design page names the
 * collections (`draft`, `manifest`) and nothing has published them; the field names
 * are this build's, because a published `org.anthers.*` schema is a commitment that goes to
 * Parker before it goes to the network. Keeping the shapes in one module means the writer,
 * the tests and a future Lexicon disagree with one place rather than with three call sites.
 *
 * 🚨 **The bytes are never in the record.** A `ManifestFile.key` is a storage pointer — the
 * R2 key the media actually lives under — not a URL, and a repository is not a CDN. Delivery
 * still checks the ledger and mints its own address; what the manifest adds is the list of
 * what the audience was promised, in a home the creator owns.
 *
 * ⚠️ **A manifest carries no CID.** A CID is the address of a record or blob in a repository,
 * and these bytes are deliberately not uploaded as blobs, so there is nothing to compute one
 * from. When the bytes ever move into a space, `cid` joins these entries; until then a made-up
 * one would be a lie a third party could not verify.
 */

/**
 * The collections a creator space declares.
 *
 * ⭐ **One type, two audiences, and both collections.** The approved creator-space shape is
 * `org.anthers.creatorSpace` with `draft` and `manifest`; a creator's private space is the
 * same type keyed `self`, and a gated Work's is keyed by its public id. Declaring both
 * collections on the type is what lets one permission over the type cover the creator's own
 * spaces, whether the app is writing a draft or reading a manifest it owns.
 */
export const CREATOR_SPACE_COLLECTIONS = {
	draft: "org.anthers.draft",
	manifest: "org.anthers.manifest",
} as const;

/**
 * One deliverable file, as the manifest names it.
 *
 * `role` is what the file is to the Work rather than what it is to a player: `source` is the
 * primary uploaded artifact (the video, the audio, an ebook's PDF), `original` is the upload a
 * remux replaced, `download` is an attached build or installer, and `build` is a browser
 * build's root. A consumer that only wants the thing a reader downloads can filter on the
 * first and third.
 */
export interface ManifestFile {
	name: string;
	key: string;
	bytes?: number;
	mimeType?: string;
	role: "source" | "original" | "download" | "build";
	platform?: string;
	version?: string;
}

/** The complete state a draft record is built from. */
export interface DraftWorkState {
	workId: number;
	publicId: number;
	kind: string;
	title: string;
	description?: string | null;
	url: string;
	files: ManifestFile[];
	/** The public listing, once there is one. */
	publishedAs?: string | null;
	updatedAt: Date;
}

/**
 * One `org.anthers.draft` record.
 *
 * ⚠️ **The draft is a copy of the Work's private half, not a second editable copy.** The
 * Studio still writes the row, and this record is the projection the creator owns; two
 * editable homes would be two answers to what a draft says. Publishing creates a different
 * record in the public repository, and `publishedAs` is the pointer that keeps the pair
 * legible without pretending their URIs are the same.
 */
export type DraftWorkRecord = {
	$type: typeof CREATOR_SPACE_COLLECTIONS.draft;
	workId: number;
	publicId: number;
	kind: string;
	title: string;
	description?: string;
	url: string;
	files: ManifestFile[];
	publishedAs?: string;
	updatedAt: string;
} & Record<string, unknown>;

/** The complete state a manifest record is built from. */
export interface GatedManifestState {
	workId: number;
	publicId: number;
	kind: string;
	title: string;
	url: string;
	files: ManifestFile[];
	/** The public listing's address, once the listing has been written. */
	work?: string | null;
	updatedAt: Date;
}

/**
 * One `org.anthers.manifest` record.
 *
 * The space is keyed by `publicId`, so a Work's manifest is the only thing of its kind there;
 * `work` points back at the public listing for a consumer that found the space first. It is
 * absent on the first publish, because the manifest is written before the listing — the
 * listing is the thing that points here, and a pointer to a record that does not exist yet
 * would be the one order that cannot be repaired.
 */
export type GatedManifestRecord = {
	$type: typeof CREATOR_SPACE_COLLECTIONS.manifest;
	workId: number;
	publicId: number;
	work?: string;
	url: string;
	title: string;
	kind: string;
	files: ManifestFile[];
	updatedAt: string;
} & Record<string, unknown>;

/** The draft's key is the Work's durable public id, so a rename keeps the record. */
export function draftWorkRkey(publicId: number): string {
	return String(publicId);
}

/** A work's space holds exactly one manifest, and a re-publish replaces it in place. */
export const GATED_MANIFEST_RKEY = "manifest";

export function draftWorkRecord(state: DraftWorkState): DraftWorkRecord {
	return {
		$type: CREATOR_SPACE_COLLECTIONS.draft,
		workId: state.workId,
		publicId: state.publicId,
		kind: state.kind,
		title: state.title,
		...(state.description ? { description: state.description } : {}),
		url: state.url,
		files: state.files,
		...(state.publishedAs ? { publishedAs: state.publishedAs } : {}),
		updatedAt: state.updatedAt.toISOString(),
	};
}

export function gatedManifestRecord(state: GatedManifestState): GatedManifestRecord {
	return {
		$type: CREATOR_SPACE_COLLECTIONS.manifest,
		workId: state.workId,
		publicId: state.publicId,
		...(state.work ? { work: state.work } : {}),
		url: state.url,
		title: state.title,
		kind: state.kind,
		files: state.files,
		updatedAt: state.updatedAt.toISOString(),
	};
}
