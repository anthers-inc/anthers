// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * S3-compatible storage implementation for DigitalOcean Spaces (production).
 *
 * Uses @aws-sdk/client-s3 — the same SDK the DO reference project uses.
 * Spaces is S3-compatible, so this works with any S3-compatible provider.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageService } from "./types.js";

const region = process.env.SPACES_REGION ?? "nyc3";
const bucket = process.env.SPACES_BUCKET ?? "";

const s3 = new S3Client({
	region,
	endpoint: `https://${region}.digitaloceanspaces.com`,
	credentials: {
		accessKeyId: process.env.SPACES_KEY ?? "",
		secretAccessKey: process.env.SPACES_SECRET ?? "",
	},
	forcePathStyle: false, // DO Spaces requires virtual-hosted style
	// DO Spaces doesn't support the AWS SDK's default flexible-checksum trailers
	// (they change x-amz-content-sha256 to a STREAMING-…-TRAILER value, which
	// Spaces rejects with SignatureDoesNotMatch). Only checksum when an operation
	// actually requires it — restores plain SigV4 that Spaces validates correctly.
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});

export class S3StorageService implements StorageService {
	async upload(
		key: string,
		body: Buffer | Uint8Array,
		contentType: string,
		acl: "public" | "private" = "public",
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

	async getUrl(key: string, opts?: { signed?: boolean; expiresIn?: number }): Promise<string> {
		if (opts?.signed) {
			return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
				expiresIn: opts.expiresIn ?? 3600,
			});
		}
		// Bare public URL
		return `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;
	}

	async getPresignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
		return getSignedUrl(
			s3,
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				ContentType: contentType,
			}),
			{ expiresIn },
		);
	}

	async delete(key: string): Promise<void> {
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
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
