// SPDX-License-Identifier: Apache-2.0
/**
 * The creator spaces: the Studio's private draft and a gated Work's manifest.
 *
 * ⭐ **Two spaces of one type, because they have two audiences.** A draft is readable by its
 * creator and nobody else, and every creator has one — the design calls that a creator's
 * private studio. A gated Work's manifest is readable by the audience its gate admits, which
 * for a purchase is one Work's buyers, so that space is per Work. Both are
 * `org.anthers.creatorSpace`: keyed `self` for the creator's own space, and keyed by the Work's
 * durable `publicId` for a gated one, which is the address the gate already maps back to the
 * Work. The listing's `access.space` pointer and the authority's question are therefore the
 * same address by construction rather than by a second convention.
 *
 * 🚨 **The record is written before the listing that points at it.** A listing is public the
 * moment it lands, so a gated listing that names a space whose manifest has not been written
 * yet is the first thing a reader follows to nothing. This module puts the draft and the
 * manifest, verifies both, and only then lets `work-listing.ts` build the record; the one
 * pointer it cannot know until the listing exists — the draft's `publishedAs` and the
 * manifest's `work` — is filled by {@link linkCreatorSpace} immediately afterwards.
 *
 * ⚠️ **The database is the outbox and the creator owns the record.** The Studio still writes
 * the Work row, and the job mirrors it here; a failed space write leaves the row as the
 * backlog and the job's retry converges. The outbox table is not reused because it is shaped
 * for a user's space — one row per reader state, drained against the account's own space —
 * while a creator-space write is one idempotent record per publish, already inside a retrying
 * job.
 *
 * ⚠️ **Only a hosted identity can write here today.** A creator whose identity lives elsewhere
 * needs an OAuth grant whose scope includes `space:org.anthers.creatorSpace…`, and the app's
 * permission sets ship with the production image. Until then this answers `no_session` for
 * those creators, exactly as the public-repository writer answers `not_granted`, and the
 * listing is written without a space pointer.
 */
import { db } from "@anthers/db";
import {
	assets,
	users,
	webBuildFiles,
	webBuilds,
	workSourceFiles,
	works,
} from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	type PublishableWork,
	publicAccessState,
	workBaseUrl,
	workUrl,
} from "./atproto-records.js";
import { type SpaceAppAccess, type SpacePolicy, SpaceRequestError } from "./atproto-space.js";
import { attestableClientId } from "./client-attestation.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	type DraftWorkRecord,
	draftWorkRecord,
	draftWorkRkey,
	GATED_MANIFEST_RKEY,
	type GatedManifestRecord,
	gatedManifestRecord,
	type ManifestFile,
} from "./creator-space-records.js";
import { type ManagingAppIdentity, managingAppIdentity } from "./managing-app.js";
import { CREATOR_SPACE_TYPE } from "./space-gate.js";
import {
	hostedSpaceSession,
	putVerifiedSpaceRecord,
	type ResolveSpaceSession,
	type SpaceSession,
	spaceClientFor,
	spaceWriterFor,
} from "./space-writer.js";
import { storage } from "./storage/index.js";
import { urlToKey } from "./storage/keys.js";

/**
 * The creator's private space: one per creator, holding drafts and private notes.
 *
 * ⚠️ **The same type as a gated Work's space.** The approved creator-space type is
 * `org.anthers.creatorSpace`; `self` is the creator's own space and a Work's public id is that
 * Work's gated space. The gate maps only the numeric keys back to a Work, so `self` is not a
 * gate it can be asked about — which is right, because the private space never asks anybody.
 */
export const STUDIO_SPACE_SKEY = "self";

/** A draft's key is the Work's public id, and a Work's gated space is keyed by it too. */
export function studioSpaceUri(did: string): string {
	return `at://${did}/space/${CREATOR_SPACE_TYPE}/${STUDIO_SPACE_SKEY}`;
}

export function gatedSpaceUri(did: string, publicId: number): string {
	return `at://${did}/space/${CREATOR_SPACE_TYPE}/${publicId}`;
}

/**
 * A studio space's policies: the member list, with no members but its owner.
 *
 * ⭐ **Owner-only by construction rather than by a special policy.** The member-list policy
 * with an empty list is what the protocol already means by "this space's audience is its
 * owner", and it needs no new type. App access stays open until the app perimeter lands,
 * exactly as the user space does.
 */
export const STUDIO_SPACE_POLICIES = {
	readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" } as SpacePolicy,
	writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" } as SpacePolicy,
	appAccess: { $type: "com.atproto.simplespace.defs#open" } as const,
};

/**
 * A gated space names Anthers as its managing app, and its app perimeter names the app.
 *
 * ⭐ **The allow-list is the first gate, and it is the app's own client id.** A space authority
 * verifies the client attestation against the JWKS the client id publishes before it asks the
 * managing app anything, so an app that is not on this list never reaches `checkUserAccess`.
 * Without an attestable client id — a checkout serving the loopback shape, or a deployment
 * missing its key — the space stays open rather than allowing a list nobody can satisfy.
 */
function gatedSpacePolicies(
	managingApp: ManagingAppIdentity,
	clientId: string | null,
): {
	readPolicy: SpacePolicy;
	writePolicy: SpacePolicy;
	appAccess:
		| { $type: "com.atproto.simplespace.defs#open" }
		| {
				$type: "com.atproto.simplespace.defs#allowList";
				allowed: string[];
		  };
} {
	const policy: SpacePolicy = {
		$type: "com.atproto.simplespace.defs#managingAppPolicy",
		managingApp: managingApp.serviceId,
	};
	return {
		readPolicy: policy,
		writePolicy: { ...policy },
		appAccess: clientId
			? { $type: "com.atproto.simplespace.defs#allowList", allowed: [clientId] }
			: { $type: "com.atproto.simplespace.defs#open" },
	};
}

/** Why a creator-space sync wrote nothing, when the reason is ordinary. */
export type CreatorSpaceSkip =
	| "no_work"
	| "no_creator"
	| "quarantined"
	| "no_session"
	| "no_managing_app"
	| "unsupported";

/** The three addresses a Work's creator-space records live at. */
export interface CreatorSpaceRefs {
	draftUri: string | null;
	spaceUri: string | null;
	manifestUri: string | null;
}

export interface CreatorSpaceSync {
	refs: CreatorSpaceRefs;
	skipped?: CreatorSpaceSkip;
	/** The records as they were written, for the pointer pass that needs no second read. */
	draft?: { space: string; record: DraftWorkRecord };
	manifest?: { space: string; record: GatedManifestRecord };
	session?: SpaceSession;
}

export interface CreatorSpaceOptions {
	/** Defaults to the hosted route. Tests inject a session over a fake PDS. */
	resolveSession?: ResolveSpaceSession;
	/** Defaults to the deployment's own identity. */
	managingApp?: ManagingAppIdentity | null;
	/** The client id a gated space's app perimeter allow-lists; defaults to the app's own. */
	clientId?: string | null;
	fetchImpl?: typeof fetch;
	now?: Date;
}

/** The Work columns both records are built from, plus the creator's identity. */
interface CreatorWorkRow extends PublishableWork {
	atprotoDid: string;
	/** Where the public listing lives, when there is one. */
	atprotoUri: string | null;
	draftUri: string | null;
	gatedSpaceUri: string | null;
	manifestUri: string | null;
	sourceKey: string | null;
	sourceOriginalKey: string | null;
}

/**
 * Read the Work and the creator's DID together.
 *
 * The join is inner because a creator-space record belongs to a DID, and a Work whose creator
 * is gone has nobody to own it — its listing is being taken down, not re-homed.
 */
async function readCreatorWork(workId: number): Promise<CreatorWorkRow | null> {
	const [row] = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			publicId: works.publicId,
			slug: works.slug,
			type: works.type,
			title: works.title,
			description: works.description,
			visibility: works.visibility,
			releasedAt: works.releasedAt,
			originallyReleased: works.originallyReleased,
			access: works.access,
			credits: works.credits,
			maturity: works.maturity,
			streamEnabled: works.streamEnabled,
			downloadEnabled: works.downloadEnabled,
			takedownStatus: works.takedownStatus,
			quarantineStatus: works.quarantineStatus,
			atprotoUri: works.atprotoUri,
			sourceKey: works.sourceKey,
			sourceOriginalKey: works.sourceOriginalKey,
			draftUri: works.draftUri,
			gatedSpaceUri: works.gatedSpaceUri,
			manifestUri: works.manifestUri,
			atprotoDid: users.atprotoDid,
		})
		.from(works)
		.innerJoin(users, eq(users.id, works.creatorId))
		.where(eq(works.id, workId))
		.limit(1);
	if (!row?.atprotoDid) return null;
	return row as CreatorWorkRow;
}

function refsOf(work: {
	draftUri: string | null;
	gatedSpaceUri: string | null;
	manifestUri: string | null;
}): CreatorSpaceRefs {
	return {
		draftUri: work.draftUri,
		spaceUri: work.gatedSpaceUri,
		manifestUri: work.manifestUri,
	};
}

/**
 * A server that has no space endpoints at all.
 *
 * ⚠️ **Production still runs an image whose PDS tracks `main`**, which does not carry the
 * space lexicons, so this feature is staged before it is live. Treating "this server has no
 * such method" as an ordinary skip is what lets the code ship with the app and start working
 * the day a spaces-capable image is pinned — rather than failing every listing sync until
 * somebody remembers a flag. Any other failure is still real and still retried.
 */
function isUnsupportedSpaceServer(error: unknown): boolean {
	if (!(error instanceof SpaceRequestError)) return false;
	if (error.status === 404 || error.status === 501) return true;
	return (
		error.error === "MethodNotImplemented" ||
		error.error === "MethodNotFound" ||
		error.error === "UnknownMethod" ||
		error.error === "XRPCNotSupported"
	);
}

/**
 * Bring a Work's creator-space records into line with it.
 *
 * Idempotent: every call re-derives the records from the row and puts them at stable keys, so
 * running it twice is harmless and running it late still converges. A Work that is neither
 * released nor gated writes only its draft; a gated one writes the manifest into its own
 * space as well.
 */
export async function syncCreatorSpace(
	workId: number,
	opts: CreatorSpaceOptions = {},
): Promise<CreatorSpaceSync> {
	const work = await readCreatorWork(workId);
	if (!work)
		return { refs: { draftUri: null, spaceUri: null, manifestUri: null }, skipped: "no_work" };

	const refs = refsOf(work);
	if (work.quarantineStatus === "quarantined") return { refs, skipped: "quarantined" };
	if (work.creatorId === null) return { refs, skipped: "no_creator" };

	try {
		return await writeCreatorSpace(work, refs, opts);
	} catch (error) {
		if (isUnsupportedSpaceServer(error)) return { refs, skipped: "unsupported" };
		throw error;
	}
}

async function writeCreatorSpace(
	work: CreatorWorkRow,
	refs: CreatorSpaceRefs,
	opts: CreatorSpaceOptions,
): Promise<CreatorSpaceSync> {
	if (work.creatorId === null) return { refs, skipped: "no_creator" };
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(work.creatorId);
	if (!resolved.session) return { refs, skipped: "no_session" };
	const session = resolved.session;

	// ⭐ **The draft exists in every state, including withdrawn.** A withdrawal takes the
	// listing down; it does not take the creator's own copy away, and a Work that returns to
	// private must still find its draft where it left it.
	const files = await manifestFilesFor(work);
	const studio = await ensureSpace(
		session,
		{
			spaceType: CREATOR_SPACE_TYPE,
			skey: STUDIO_SPACE_SKEY,
			...STUDIO_SPACE_POLICIES,
		},
		opts.fetchImpl,
	);
	const draftRecord = draftWorkRecord({
		workId: work.id,
		publicId: work.publicId,
		kind: work.type,
		title: work.title ?? "",
		description: work.description,
		url: workUrl(work, workBaseUrl()),
		files,
		publishedAs: work.visibility === "released" ? work.atprotoUri : null,
		updatedAt: opts.now ?? new Date(),
	});
	const draftRef = await putVerifiedSpaceRecord(
		spaceWriterFor(session, studio, { fetchImpl: opts.fetchImpl }),
		CREATOR_SPACE_COLLECTIONS.draft,
		draftWorkRkey(work.publicId),
		draftRecord,
	);

	const sync: CreatorSpaceSync = {
		refs: { ...refs, draftUri: draftRef.uri },
		draft: { space: studio, record: draftRecord },
		session,
	};

	// Only a released Work has a listing to point at a gated space, and only a listing whose
	// strangers are gated has an audience to write for.
	const gated = work.visibility === "released" && publicAccessState(work) === "gated";
	if (!gated) {
		if (work.draftUri !== draftRef.uri) await storeRefs(work.id, { draftUri: draftRef.uri });
		return sync;
	}

	const managingApp = opts.managingApp ?? managingAppIdentity();
	if (!managingApp) {
		if (work.draftUri !== draftRef.uri) await storeRefs(work.id, { draftUri: draftRef.uri });
		return { ...sync, skipped: "no_managing_app" };
	}

	const space = await ensureSpace(
		session,
		{
			spaceType: CREATOR_SPACE_TYPE,
			skey: String(work.publicId),
			...gatedSpacePolicies(
				managingApp,
				opts.clientId !== undefined ? opts.clientId : attestableClientId(),
			),
		},
		opts.fetchImpl,
	);
	const manifestRecord = gatedManifestRecord({
		workId: work.id,
		publicId: work.publicId,
		work: work.atprotoUri,
		url: workUrl(work, workBaseUrl()),
		title: work.title ?? "",
		kind: work.type,
		files,
		updatedAt: opts.now ?? new Date(),
	});
	const manifestRef = await putVerifiedSpaceRecord(
		spaceWriterFor(session, space, { fetchImpl: opts.fetchImpl }),
		CREATOR_SPACE_COLLECTIONS.manifest,
		GATED_MANIFEST_RKEY,
		manifestRecord,
	);

	sync.refs.spaceUri = space;
	sync.refs.manifestUri = manifestRef.uri;
	sync.manifest = { space, record: manifestRecord };

	const updates: { draftUri?: string; gatedSpaceUri?: string; manifestUri?: string } = {};
	if (work.draftUri !== draftRef.uri) updates.draftUri = draftRef.uri;
	if (work.gatedSpaceUri !== space) updates.gatedSpaceUri = space;
	if (work.manifestUri !== manifestRef.uri) updates.manifestUri = manifestRef.uri;
	if (Object.keys(updates).length > 0) await storeRefs(work.id, updates);
	return sync;
}

/** Record where the creator-space writes actually landed. */
async function storeRefs(
	workId: number,
	updates: { draftUri?: string; gatedSpaceUri?: string; manifestUri?: string },
): Promise<void> {
	await db.update(works).set(updates).where(eq(works.id, workId));
}

/**
 * Point the creator-space records at the listing that now exists, or clear the pointer when
 * it no longer does.
 *
 * ⭐ **A second pass gated on whether the listing actually moved.** The records were just
 * written and verified, so the sync hands them back and this writes once more only when the
 * listing's address changed. That transition is the one edit the order of writes makes
 * impossible in the first pass — the listing is written after the manifest, because the
 * manifest is what the listing points at — and `previousListingUri` is what tells the two
 * passes apart. Comparing against the record in hand would not: on a withdrawal the row's
 * `atproto_uri` has not been cleared yet, so the first pass has nothing to disagree with and
 * the stale pointer would survive.
 */
export async function linkCreatorSpace(
	sync: CreatorSpaceSync,
	listingUri: string | null,
	previousListingUri: string | null,
	opts: CreatorSpaceOptions = {},
): Promise<void> {
	if (!sync.session) return;
	if (previousListingUri === listingUri) return;
	const writerOpts = { fetchImpl: opts.fetchImpl };

	if (sync.draft) {
		const record = listingUri
			? { ...sync.draft.record, publishedAs: listingUri }
			: (() => {
					const { publishedAs: _publishedAs, ...rest } = sync.draft.record;
					return rest;
				})();
		await putVerifiedSpaceRecord(
			spaceWriterFor(sync.session, sync.draft.space, writerOpts),
			CREATOR_SPACE_COLLECTIONS.draft,
			draftWorkRkey(record.publicId),
			record,
		);
	}

	if (sync.manifest) {
		const record = listingUri
			? { ...sync.manifest.record, work: listingUri }
			: (() => {
					const { work: _work, ...rest } = sync.manifest.record;
					return rest;
				})();
		await putVerifiedSpaceRecord(
			spaceWriterFor(sync.session, sync.manifest.space, writerOpts),
			CREATOR_SPACE_COLLECTIONS.manifest,
			GATED_MANIFEST_RKEY,
			record,
		);
	}
}

/**
 * Remove what a deleted Work owned, before its row goes.
 *
 * A Work deleted before anyone bought it has no one left to read its gated space, so the space
 * goes with it; the studio space stays, because it belongs to the creator and may hold other
 * drafts. A Work that was bought is withdrawn rather than deleted, so this never runs for a
 * space somebody is still entitled to read.
 *
 * ⚠️ **Best effort, and the route logs rather than failing the delete.** The creator asked for
 * their Work to go; refusing because a second server is unreachable would trap them in a
 * half-deleted state, and the address is already lost with the row either way.
 */
export async function removeCreatorSpace(
	work: {
		creatorId: number | null;
		publicId: number;
		draftUri: string | null;
		gatedSpaceUri: string | null;
	},
	opts: CreatorSpaceOptions = {},
): Promise<void> {
	if (work.creatorId === null) return;
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(work.creatorId);
	if (!resolved.session) return;
	const session = resolved.session;
	const client = spaceClientFor(session, { fetchImpl: opts.fetchImpl });

	if (work.gatedSpaceUri) {
		await client.deleteSpace(work.gatedSpaceUri).catch((error) => {
			if (error instanceof SpaceRequestError && error.error === "SpaceNotFound") return;
			throw error;
		});
	}
	if (work.draftUri) {
		await spaceWriterFor(session, studioSpaceUri(session.did), {
			fetchImpl: opts.fetchImpl,
		})
			.remove(CREATOR_SPACE_COLLECTIONS.draft, draftWorkRkey(work.publicId))
			.catch((error) => {
				if (
					error instanceof SpaceRequestError &&
					(error.error === "RecordNotFound" || error.error === "NotFound")
				) {
					return;
				}
				throw error;
			});
	}
}

/**
 * Create the space if it is not there, and return its address.
 *
 * ⭐ **Look first, create second, look again on the conflict.** `createSpace` is idempotent
 * only in the sense that it answers `SpaceAlreadyExists`; a crash between the create and the
 * write that follows would otherwise make every retry fail forever. The listing is by owner
 * and type, and the key is matched exactly, so a space of the same type under another Work is
 * not mistaken for this one.
 */
async function ensureSpace(
	session: SpaceSession,
	input: {
		spaceType: string;
		skey: string;
		readPolicy: SpacePolicy;
		writePolicy: SpacePolicy;
		appAccess: SpaceAppAccess;
	},
	fetchImpl?: typeof fetch,
): Promise<string> {
	const client = spaceClientFor(session, { fetchImpl });
	const uri = `at://${session.did}/space/${input.spaceType}/${input.skey}`;
	const listed = await client.listSpaces({ did: session.did, spaceType: input.spaceType });
	if (listed.spaces.some((space) => space.uri === uri)) return uri;

	try {
		const created = await client.createSpace(input);
		return created.uri;
	} catch (error) {
		if (!(error instanceof SpaceRequestError) || error.error !== "SpaceAlreadyExists") throw error;
		const again = await client.listSpaces({ did: session.did, spaceType: input.spaceType });
		if (again.spaces.some((space) => space.uri === uri)) return uri;
		throw error;
	}
}

/**
 * The Work's deliverable files, as storage pointers.
 *
 * ⚠️ **A browser build is one entry, not one per file.** A Godot export can carry hundreds of
 * files, and a record has a size the network reads and caches; the build's pointer is its
 * prefix, and the entry names the file that loads first. Every other entry is a real object
 * with its own key.
 */
async function manifestFilesFor(work: {
	id: number;
	creatorId: number | null;
	sourceKey: string | null;
	sourceOriginalKey: string | null;
}): Promise<ManifestFile[]> {
	const [assetRows, sourceRows, buildRows] = await Promise.all([
		db.select().from(assets).where(eq(assets.workId, work.id)),
		db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, work.id)),
		db.select().from(webBuilds).where(eq(webBuilds.workId, work.id)),
	]);

	const files: ManifestFile[] = [];
	/** A size only when storage knows one: an absent key is absence, not zero bytes. */
	const bytesOf = async (key: string): Promise<{ bytes?: number }> => {
		const bytes = (await storage.size(key).catch(() => null)) ?? undefined;
		return bytes === undefined ? {} : { bytes };
	};

	for (const [key, role] of [
		[work.sourceKey, "source"] as const,
		[work.sourceOriginalKey, "original"] as const,
	]) {
		if (!key) continue;
		const storageKey = urlToKey(key);
		files.push({
			name: storageKey.split("/").pop() || storageKey,
			key: storageKey,
			...(await bytesOf(storageKey)),
			role,
		});
	}

	for (const source of sourceRows) {
		const storageKey = urlToKey(source.file);
		files.push({
			name: source.filename || storageKey.split("/").pop() || storageKey,
			key: storageKey,
			...(source.fileSize != null ? { bytes: source.fileSize } : await bytesOf(storageKey)),
			...(source.mimeType ? { mimeType: source.mimeType } : {}),
			role: "source",
		});
	}

	for (const asset of assetRows) {
		files.push({
			name: asset.filename,
			key: urlToKey(asset.file),
			...(asset.fileSize ? { bytes: asset.fileSize } : {}),
			...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
			role: "download",
			...(asset.platform ? { platform: asset.platform } : {}),
			...(asset.version ? { version: asset.version } : {}),
		});
	}

	const build = buildRows.find((row) => row.isPrimary) ?? buildRows[0];
	if (build && work.creatorId !== null) {
		const buildFiles = await db
			.select({ fileSize: webBuildFiles.fileSize })
			.from(webBuildFiles)
			.where(eq(webBuildFiles.buildId, build.id));
		files.push({
			name: build.entryPath,
			key: `creators/${work.creatorId}/web-builds/${build.id}/`,
			bytes: buildFiles.reduce((total, file) => total + (file.fileSize ?? 0), 0),
			role: "build",
			...(build.label ? { version: build.label } : {}),
		});
	}

	return files;
}
