// SPDX-License-Identifier: Apache-2.0
/**
 * Reading one gated Work's manifest as the signed-in reader.
 *
 * ⭐ **The access check is the gate's own function, not a second opinion.** The route that
 * serves a manifest and the route a space authority calls to issue a credential both ask
 * `authorizeSpaceAccess`, so a reader who is refused the credential cannot be served the
 * manifest by a different rule — and a reader the gate admits cannot be refused here for a
 * reason the app invented.
 *
 * ⚠️ **The reader's session is the hosted route today.** A reader whose identity Anthers does
 * not host needs an OAuth grant that includes a `space:` permission, and the production
 * authorization server does not know that resource until the spaces-capable image ships. Until
 * then this answers `no_session` for them, exactly as the space writer does, and the browser
 * has no ATProto session of its own to offer.
 */
import { db } from "@anthers/db";
import { users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { didKeyFromVerificationMethod } from "../lib/did-key.js";
import {
	attestableClientId,
	type ClientSigningKey,
	clientSigningKey,
} from "./client-attestation.js";
import {
	CREATOR_SPACE_COLLECTIONS,
	GATED_MANIFEST_RKEY,
	type GatedManifestRecord,
} from "./creator-space-records.js";
import { networkDidResolver, type ResolveDid } from "./service-auth.js";
import { readSpaceRecord, SpaceReadError, type SpaceReaderSession } from "./space-credential.js";
import type { SpaceAccessReason } from "./space-gate.js";
import { authorizeSpaceAccess } from "./space-gate.js";
import type { ResolveSpaceSession } from "./space-writer.js";
import { hostedSpaceSession } from "./space-writer.js";

export interface GatedManifestInput {
	workId: number;
	readerUserId: number;
	/** Defaults to the hosted route. */
	resolveSession?: ResolveSpaceSession;
	/** Defaults to the app's real resolver. */
	resolveDid?: ResolveDid;
	/** Defaults to the app's own client identity. */
	clientId?: string | null;
	clientKey?: ClientSigningKey | null;
	fetchImpl?: typeof fetch;
	now?: Date;
}

export type GatedManifestRefusal =
	| SpaceAccessReason
	| "no_work"
	| "no_manifest"
	| "no_creator"
	| "no_session"
	| "no_kem_key"
	| SpaceReadError["code"];

export type GatedManifestResult =
	| { status: "ok"; manifest: GatedManifestRecord; space: string }
	| { status: "refused"; reason: GatedManifestRefusal; detail?: string; cause?: unknown };

export async function gatedManifestFor(input: GatedManifestInput): Promise<GatedManifestResult> {
	const [[work], [readerRow]] = await Promise.all([
		db
			.select({
				id: works.id,
				creatorId: works.creatorId,
				publicId: works.publicId,
				gatedSpaceUri: works.gatedSpaceUri,
				manifestUri: works.manifestUri,
				creatorDid: users.atprotoDid,
				creatorPdsUrl: users.atprotoPdsUrl,
			})
			.from(works)
			.innerJoin(users, eq(users.id, works.creatorId))
			.where(eq(works.id, input.workId))
			.limit(1),
		db
			.select({ did: users.atprotoDid })
			.from(users)
			.where(eq(users.id, input.readerUserId))
			.limit(1),
	]);
	if (!work) return { status: "refused", reason: "no_work" };
	if (!work.creatorDid || !work.creatorPdsUrl) return { status: "refused", reason: "no_creator" };
	if (!work.gatedSpaceUri || !work.manifestUri) {
		return { status: "refused", reason: "no_manifest" };
	}
	if (!readerRow?.did) return { status: "refused", reason: "unknown-user" };

	// The same question the authority will ask, answered before a credential is requested.
	const decision = await authorizeSpaceAccess({
		space: work.gatedSpaceUri,
		authority: work.creatorDid,
		userDid: readerRow.did,
		access: "read",
	});
	if (!decision.authorized) return { status: "refused", reason: decision.reason };

	const resolveSession = input.resolveSession ?? hostedSpaceSession({ fetchImpl: input.fetchImpl });
	const resolved = await resolveSession(input.readerUserId);
	if (!resolved.session) return { status: "refused", reason: "no_session" };

	const resolveDid = input.resolveDid ?? networkDidResolver;
	let kemDidKey: string | null = null;
	try {
		const document = await resolveDid(work.creatorDid);
		const method = document?.verificationMethod?.find(
			(candidate) => candidate.id === "#atproto_kem" || candidate.id?.endsWith("#atproto_kem"),
		);
		kemDidKey = method ? didKeyFromVerificationMethod(method) : null;
	} catch (error) {
		return { status: "refused", reason: "no_kem_key", cause: error };
	}
	if (!kemDidKey) {
		return {
			status: "refused",
			reason: "no_kem_key",
			detail: "the creator's DID document publishes no #atproto_kem key",
		};
	}

	const reader: SpaceReaderSession = resolved.session;
	try {
		const read = await readSpaceRecord({
			reader,
			creatorDid: work.creatorDid,
			creatorPdsUrl: work.creatorPdsUrl,
			space: work.gatedSpaceUri,
			collection: CREATOR_SPACE_COLLECTIONS.manifest,
			rkey: GATED_MANIFEST_RKEY,
			expectedUri: work.manifestUri,
			authorKemDidKey: kemDidKey,
			clientId: input.clientId !== undefined ? input.clientId : attestableClientId(),
			clientKey: input.clientKey !== undefined ? input.clientKey : clientSigningKey(),
			fetchImpl: input.fetchImpl,
			now: input.now,
		});
		const manifest = read.record.value as GatedManifestRecord | null;
		if (
			!manifest ||
			typeof manifest !== "object" ||
			manifest.$type !== CREATOR_SPACE_COLLECTIONS.manifest ||
			!Array.isArray(manifest.files)
		) {
			return { status: "refused", reason: "wrong_record" };
		}
		return { status: "ok", manifest, space: work.gatedSpaceUri };
	} catch (error) {
		if (error instanceof SpaceReadError) {
			return { status: "refused", reason: error.code, detail: error.message, cause: error.cause };
		}
		return {
			status: "refused",
			reason: "request",
			detail: error instanceof Error ? error.message : String(error),
			cause: error,
		};
	}
}
