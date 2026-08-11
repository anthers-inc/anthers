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
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { publicUrlFor, resolveStorageConfig } from "./config.js";
import type { StorageService } from "./types.js";

const config = resolveStorageConfig();
const bucket = config.bucket;

const s3 = new S3Client({
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
	// behaviour change to Spaces made on the way past.
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});

export class S3StorageService implements StorageService {
	async upload(
		key: string,
		body: Buffer | Uint8Array,
		contentType: string,
		// Defaults PRIVATE — fail closed. This defaulted to "public", which meant any
		// call site that forgot the argument published its object, and that is the
		// mechanism by which gated HLS playlists ended up world-readable. Every call
		// site passes explicitly today, so this default is a backstop rather than a
		// behaviour: the point is that the next one to forget gets a locked object
		// and a bug report, not a silent leak.
		acl: "public" | "private" = "private",
	): Promise<string> {
		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: body,
				ContentType: contentType,
				ACL: acl === "public" ? "public-read" : "private",
			}),
		);
		return key;
	}

	async downloadToTemp(key: string): Promise<string> {
		const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

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
			const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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
			const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
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
			const response = await s3.send(
				new GetObjectCommand({
					Bucket: bucket,
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
		if (opts?.signed) {
			return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
				expiresIn: opts.expiresIn ?? 3600,
			});
		}
		// Bare public URL. Byte-identical to the old hard-coded template when nothing
		// overrides `publicBaseUrl` — see config.ts.
		return publicUrlFor(config, key);
	}

	async getPresignedUploadUrl(
		key: string,
		contentType: string,
		acl: "public" | "private",
		expiresIn = 3600,
	): Promise<{ url: string; headers: Record<string, string> }> {
		const value = acl === "public" ? "public-read" : "private";
		const url = await getSignedUrl(
			s3,
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				ContentType: contentType,
				ACL: value,
			}),
			{ expiresIn },
		);
		// The ACL is returned as a header for the client to echo, not left to the URL.
		// getSignedUrl hoists `x-amz-acl` into the query string, and Spaces ignores it
		// there — signing alone is a no-op. See the note on the interface.
		return { url, headers: { "x-amz-acl": value } };
	}

	async delete(key: string): Promise<void> {
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	}

	async deletePrefix(prefix: string): Promise<void> {
		// List (paginated) then batch-delete every object under the prefix.
		let continuationToken: string | undefined;
		do {
			const listed = await s3.send(
				new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			);
			const objects = (listed.Contents ?? [])
				.map((o) => o.Key)
				.filter((k): k is string => !!k)
				.map((Key) => ({ Key }));
			if (objects.length > 0) {
				await s3.send(
					new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
				);
			}
			continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
		} while (continuationToken);
	}

	async exists(key: string): Promise<boolean> {
		try {
			await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
			return true;
		} catch {
			return false;
		}
	}
}
