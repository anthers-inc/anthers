// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * S3-compatible object storage (production).
 *
 * Uses @aws-sdk/client-s3. The provider is **configuration**, not a constant in this file:
 * endpoint, bucket, credentials, addressing style and the public URL base all come from
 * `resolveStorageConfig()`, whose defaults reproduce DigitalOcean Spaces exactly. An
 * environment that sets nothing new behaves identically to before that split existed.
 *
 * See `config.ts` for why `publicBaseUrl` matters more than it looks — absolute URLs are
 * persisted in the database and decoded back to keys by their pathname, so pointing it at a
 * path-style endpoint silently corrupts every URL written afterwards.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CopyObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertServableKey, isPublicKey } from "./acl.js";
import { publicUrlFor, resolveStorageConfig, type StorageConfig } from "./config.js";
import type { StorageService } from "./types.js";

function clientFor(config: StorageConfig): S3Client {
	return new S3Client({
		region: config.region,
		endpoint: config.endpoint,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
		// False for Spaces, which requires virtual-hosted style; R2's S3 API wants true.
		forcePathStyle: config.forcePathStyle,
		// DO Spaces doesn't support the AWS SDK's default flexible-checksum trailers
		// (they change x-amz-content-sha256 to a STREAMING-…-TRAILER value, which
		// Spaces rejects with SignatureDoesNotMatch). Only checksum when an operation
		// actually requires it — restores plain SigV4 that Spaces validates correctly.
		//
		// ⚠️ Kept unconditionally rather than made provider-specific. It is the conservative
		// setting everywhere — it only ever *omits* optional checksums — so a provider that
		// would accept the trailers loses nothing, while flipping it per-provider would be a
		// behavior change to Spaces made on the way past.
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
}

export class S3StorageService implements StorageService {
	private readonly config: StorageConfig;
	private readonly s3: S3Client;

	/**
	 * Configuration is INJECTABLE, and the default reads the environment exactly as before.
	 *
	 * It used to be resolved once at module scope, which made this class untestable in any
	 * process where something else imported it first: `routes/content.ts` pulls storage in
	 * transitively, so by the time a test set `process.env` the config was already frozen and
	 * the test silently asserted against the ambient environment instead of its own. That is
	 * how `storage-acl.test.ts` came to pass in CI (no `.env`) and fail locally (a real
	 * `STORAGE_PUBLIC_BUCKET` set for the R2 migration) — the same shape as the `getStripe()`
	 * problem, where "is it configured?" became a property of the machine rather than of the
	 * test. Production still constructs exactly one instance, in the `index.ts` factory.
	 */
	constructor(config: StorageConfig = resolveStorageConfig()) {
		this.config = config;
		this.s3 = clientFor(config);
	}

	/**
	 * Which bucket an object belongs in.
	 *
	 * Two callers, and the difference matters. **Writes know the ACL** — every `upload` and
	 * every presigned upload is handed `"public"` or `"private"` by `aclForMediaType`, so they
	 * pass it here and the answer is exact. **Reads only have the key**, so they go through
	 * `isPublicKey`, which reads the same policy from the other end.
	 *
	 * Both fail closed toward the private bucket, and while `STORAGE_PUBLIC_BUCKET` is unset the
	 * two are the same bucket and this function cannot be wrong about anything.
	 */
	private bucketFor(acl: "public" | "private"): string {
		return acl === "public" ? this.config.publicBucket : this.config.bucket;
	}

	/** The bucket a key lives in, for the operations that are given no ACL. */
	private bucketForKey(key: string): string {
		return this.bucketFor(isPublicKey(key) ? "public" : "private");
	}
	async upload(
		key: string,
		body: Buffer | Uint8Array,
		contentType: string,
		// Defaults PRIVATE — fail closed. This defaulted to "public", which meant any
		// call site that forgot the argument published its object, and that is the
		// mechanism by which gated HLS playlists ended up world-readable. Every call
		// site passes explicitly today, so this default is a backstop rather than a
		// behavior: the point is that the next one to forget gets a locked object
		// and a bug report, not a silent leak.
		acl: "public" | "private" = "private",
	): Promise<string> {
		await this.s3.send(
			new PutObjectCommand({
				Bucket: this.bucketFor(acl),
				Key: key,
				Body: body,
				ContentType: contentType,
				// Still sent, and still meaningful on S3/Spaces where one bucket holds both.
				// R2 ignores it — there the bucket IS the ACL, which is what `bucketFor` is.
				ACL: acl === "public" ? "public-read" : "private",
			}),
		);
		return key;
	}

	async downloadToTemp(key: string): Promise<string> {
		const response = await this.s3.send(
			new GetObjectCommand({ Bucket: this.bucketForKey(key), Key: key }),
		);

		if (!response.Body) {
			throw new Error(`S3 object ${key} has no body`);
		}

		// Stream to a temp file
		const ext = key.includes(".") ? `.${key.split(".").pop()}` : "";
		const tempPath = join(tmpdir(), `s3dl_${randomUUID()}${ext}`);
		const bytes = await response.Body.transformToByteArray();
		await Bun.write(tempPath, bytes);
		return tempPath;
	}

	async read(key: string): Promise<Uint8Array | null> {
		try {
			const response = await this.s3.send(
				new GetObjectCommand({ Bucket: this.bucketForKey(key), Key: key }),
			);
			if (!response.Body) return null;
			return await response.Body.transformToByteArray();
		} catch {
			// A missing key is a 404 from the SDK, and every caller wants "not found",
			// not an exception — the endpoints above all turn it into their own 404.
			return null;
		}
	}

	async size(key: string): Promise<number | null> {
		try {
			const head = await this.s3.send(
				new HeadObjectCommand({ Bucket: this.bucketForKey(key), Key: key }),
			);
			return head.ContentLength ?? null;
		} catch {
			return null;
		}
	}

	async readRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
		if (length <= 0) return new Uint8Array(0);
		try {
			// HTTP byte ranges are INCLUSIVE at both ends, so the last byte is
			// offset + length - 1. Off-by-one here reads one byte too many into every
			// chunk, which fails the manifest hash rather than corrupting silently —
			// but only on the chunks that aren't last, so test the final chunk too.
			const response = await this.s3.send(
				new GetObjectCommand({
					Bucket: this.bucketForKey(key),
					Key: key,
					Range: `bytes=${offset}-${offset + length - 1}`,
				}),
			);
			if (!response.Body) return null;
			return await response.Body.transformToByteArray();
		} catch {
			// Same reasoning as `read`: a missing key is a 404 from the SDK and every
			// caller wants "not found". Note this also swallows a 416 (range past the end
			// of the object), which is the correct answer for a chunk index that doesn't
			// exist — the route turns null into its own 404.
			return null;
		}
	}

	async getUrl(key: string, opts?: { signed?: boolean; expiresIn?: number }): Promise<string> {
		// The second denial. See `assertServableKey` — this is one of the two doors bytes
		// leave through, and it refuses regardless of what any caller resolved.
		assertServableKey(key);
		if (opts?.signed) {
			return getSignedUrl(
				this.s3,
				new GetObjectCommand({ Bucket: this.bucketForKey(key), Key: key }),
				{
					expiresIn: opts.expiresIn ?? 3600,
				},
			);
		}
		// Bare public URL. Byte-identical to the old hard-coded template when nothing
		// overrides `publicBaseUrl` — see config.ts.
		return publicUrlFor(this.config, key);
	}

	async getPresignedUploadUrl(
		key: string,
		contentType: string,
		acl: "public" | "private",
		expiresIn = 3600,
	): Promise<{ url: string; headers: Record<string, string> }> {
		// The other door. A presigned PUT into the quarantine prefix would let an uploader
		// write material into the one place nothing is ever checked again.
		assertServableKey(key);
		const value = acl === "public" ? "public-read" : "private";
		const url = await getSignedUrl(
			this.s3,
			new PutObjectCommand({
				Bucket: this.bucketFor(acl),
				Key: key,
				ContentType: contentType,
				ACL: value,
			}),
			{ expiresIn },
		);
		// The ACL is returned as a header for the client to echo, not left to the URL:
		// getSignedUrl hoists `x-amz-acl` into the query string, and Spaces ignores it
		// there — signing alone is a no-op. See the note on the interface.
		//
		// 🚨 But ONLY where the ACL is what carries access. On a two-bucket provider the
		// bucket carries it, and echoing the header is fatal rather than redundant: R2
		// returns `403 SignatureDoesNotMatch` for a presigned PUT that sends it, because the
		// extra header changes the canonical request the signature was computed over.
		// Verified against a live R2 bucket on 2026-08-11 — with the header 403, without it
		// 200. `this.config.sendObjectAcl` is the derivation and carries the full reasoning.
		return { url, headers: this.config.sendObjectAcl ? { "x-amz-acl": value } : {} };
	}

	/**
	 * Copy then delete. `CopyObject` takes the source as `{bucket}/{key}`, so a move that
	 * crosses buckets — the thumbnail case — is the same call with a different source.
	 */
	async move(fromKey: string, toKey: string): Promise<boolean> {
		if (fromKey === toKey) return true;
		const sourceBucket = this.bucketForKey(fromKey);
		const targetBucket = this.bucketForKey(toKey);
		try {
			await this.s3.send(
				new CopyObjectCommand({
					Bucket: targetBucket,
					Key: toKey,
					CopySource: `${sourceBucket}/${fromKey}`,
				}),
			);
		} catch {
			// A missing source is the ordinary case for a Work whose media never uploaded,
			// and it must not abort a quarantine part-way through its other objects.
			return false;
		}
		// Only after the copy has landed. The reverse order loses the bytes on a crash, and
		// the bytes are the evidence this whole path exists to preserve.
		await this.s3.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: fromKey }));
		return true;
	}

	async delete(key: string): Promise<void> {
		await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketForKey(key), Key: key }));
	}

	/**
	 * Delete everything under a prefix, **from both buckets**.
	 *
	 * Today the only caller passes an HLS directory, which is unambiguously private, so
	 * routing by prefix would work. Sweeping both anyway is the cheap side of the trade:
	 * listing a prefix that isn't there costs one empty response, while getting it wrong
	 * leaves orphaned objects that nothing will ever look for again. A prefix broad enough
	 * to span both buckets — `creators/{id}/`, say — is exactly the call someone will add
	 * later without reading this file.
	 */
	async deletePrefix(prefix: string): Promise<void> {
		const buckets =
			this.config.publicBucket === this.config.bucket
				? [this.config.bucket]
				: [this.config.bucket, this.config.publicBucket];
		for (const target of buckets) {
			// List (paginated) then batch-delete every object under the prefix.
			let continuationToken: string | undefined;
			do {
				const listed = await this.s3.send(
					new ListObjectsV2Command({
						Bucket: target,
						Prefix: prefix,
						ContinuationToken: continuationToken,
					}),
				);
				const objects = (listed.Contents ?? [])
					.map((o) => o.Key)
					.filter((k): k is string => !!k)
					.map((Key) => ({ Key }));
				if (objects.length > 0) {
					await this.s3.send(
						new DeleteObjectsCommand({
							Bucket: target,
							Delete: { Objects: objects, Quiet: true },
						}),
					);
				}
				continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
			} while (continuationToken);
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.s3.send(new HeadObjectCommand({ Bucket: this.bucketForKey(key), Key: key }));
			return true;
		} catch {
			return false;
		}
	}
}
