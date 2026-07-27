// SPDX-License-Identifier: AGPL-3.0-or-later
import { uploadImageFile } from "../components/post/mediaUpload";
import { apiAuthHeaders, apiBaseUrl, apiSendsCookies, client } from "./rpc";
import { canTranscodeInBrowser, transcodeInBrowser } from "./transcode";

/**
 * Upload a media file (video/audio/asset) using presigned URL (S3) or direct upload (local dev).
 * Returns the storage key for the uploaded file.
 */
export async function uploadMediaFile(
	file: File,
	mediaType: "video" | "audio" | "asset",
	onProgress?: (percent: number) => void,
): Promise<string> {
	// Step 1: Get upload URL from API
	const res = await client.api.content["media-upload"].presign.$post({
		json: { filename: file.name, contentType: file.type, mediaType },
	});
	if (!res.ok) throw new Error("Failed to get upload URL");
	const urlInfo = (await res.json()) as {
		method: "presigned" | "direct";
		uploadUrl: string;
		headers?: Record<string, string>;
		key: string;
	};

	if (urlInfo.method === "presigned") {
		// S3 presigned upload — PUT directly to Spaces. The server's headers must be
		// echoed verbatim: `x-amz-acl` only applies as a request header (Spaces ignores
		// the copy the presigner hoists into the query string), so dropping them here
		// silently reverts the object to the bucket default.
		await xhrUpload(urlInfo.uploadUrl, file, "PUT", onProgress, urlInfo.headers);
		return urlInfo.key;
	} else {
		// Direct multipart upload (local dev)
		const formData = new FormData();
		formData.append("file", file);
		formData.append("mediaType", mediaType);
		const result = await xhrUploadFormData<{ key: string; url: string }>(
			urlInfo.uploadUrl,
			formData,
			onProgress,
		);
		return result.key;
	}
}

function xhrUpload(
	url: string,
	file: File,
	method: string,
	onProgress?: (percent: number) => void,
	headers?: Record<string, string>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(method, url);
		for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);

		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable && onProgress) {
				onProgress(Math.round((e.loaded / e.total) * 100));
			}
		});

		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
			} else {
				reject(new Error(`Upload failed with status ${xhr.status}`));
			}
		});

		xhr.addEventListener("error", () => reject(new Error("Upload failed")));
		xhr.send(file);
	});
}

function xhrUploadFormData<T>(
	url: string,
	formData: FormData,
	onProgress?: (percent: number) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		// XHR is used here only because `fetch` has no upload-progress event — but that
		// means it also bypasses `apiFetch`, and with it the desktop's bearer header.
		// Resolve the base and the credential the same way `apiFetch` would.
		const fullUrl = url.startsWith("/") ? `${apiBaseUrl()}${url}` : url;
		xhr.open("POST", fullUrl);
		xhr.withCredentials = apiSendsCookies();
		for (const [k, v] of Object.entries(apiAuthHeaders())) xhr.setRequestHeader(k, v);

		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable && onProgress) {
				onProgress(Math.round((e.loaded / e.total) * 100));
			}
		});

		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(JSON.parse(xhr.responseText));
			} else {
				reject(new Error(`Upload failed with status ${xhr.status}`));
			}
		});

		xhr.addEventListener("error", () => reject(new Error("Upload failed")));
		xhr.send(formData);
	});
}

// ─── Client-side video transcode + upload ────────────────────────────────────

/** Variant descriptor the server needs to package the HLS ladder (key + geometry). */
export interface UploadedVariant {
	name: string;
	height: number;
	width: number;
	bitrate: string;
	bandwidth: number;
	key: string;
}

/** Result of a browser-transcoded video upload. */
export interface ClientVideoUpload {
	sourceKey: string;
	variants: UploadedVariant[];
	thumbnailKey: string;
	thumbnailPreview: string;
	durationSeconds: number;
}

/** Combined progress across encode + upload phases (single 0–100 bar). */
export interface VideoJobProgress {
	stage: string;
	percent: number;
	etaSeconds: number | null;
}

export { canTranscodeInBrowser };

/**
 * Copy ffmpeg's output bytes into a fresh ArrayBuffer-backed view. ffmpeg's FileData
 * is typed `Uint8Array<ArrayBufferLike>` (it *could* be SharedArrayBuffer-backed),
 * which TS won't accept as a BlobPart; our single-threaded core never uses SAB, so a
 * plain copy is both correct and type-clean.
 */
function toBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	return copy;
}

/**
 * Encode a video in the browser (H.264 MP4 ladder + poster), then upload the source,
 * every variant, and the thumbnail. Returns the storage keys + variant metadata for
 * the post's content element; the server will remux the variants into HLS (`-c copy`).
 *
 * Progress is a single 0–100 bar: encode dominates (0–65%), then source upload
 * (65–80%), variant uploads (80–97%), thumbnail (97–100%).
 *
 * Throws on any failure (e.g. wasm OOM, upload error) — callers should fall back to a
 * plain source upload + server-side transcode.
 */
export async function uploadClientTranscodedVideo(
	file: File,
	onProgress?: (p: VideoJobProgress) => void,
): Promise<ClientVideoUpload> {
	// ── Encode (0–65%) ──
	const result = await transcodeInBrowser(file, (p) => {
		onProgress?.({
			stage: p.stage,
			percent: Math.round(p.percent * 0.65),
			etaSeconds: p.etaSeconds,
		});
	});

	// ── Upload source (65–80%) ──
	const sourceKey = await uploadMediaFile(file, "video", (pct) =>
		onProgress?.({
			stage: "Uploading source",
			percent: 65 + Math.round(pct * 0.15),
			etaSeconds: null,
		}),
	);

	// ── Upload variants (80–97%), sequential for monotonic progress ──
	const variants: UploadedVariant[] = [];
	const span = 17 / Math.max(1, result.variants.length);
	for (let i = 0; i < result.variants.length; i++) {
		const v = result.variants[i];
		const base = 80 + i * span;
		const variantFile = new File([toBlobPart(v.data)], `${v.name}.mp4`, { type: "video/mp4" });
		const key = await uploadMediaFile(variantFile, "video", (pct) =>
			onProgress?.({
				stage: `Uploading ${v.name}`,
				percent: Math.round(base + (pct / 100) * span),
				etaSeconds: null,
			}),
		);
		variants.push({
			name: v.name,
			height: v.height,
			width: v.width,
			bitrate: v.bitrate,
			bandwidth: v.bandwidth,
			key,
		});
	}

	// ── Upload thumbnail (97–100%) ──
	let thumbnailKey = "";
	let thumbnailPreview = "";
	if (result.thumbnail) {
		onProgress?.({ stage: "Uploading thumbnail", percent: 98, etaSeconds: null });
		try {
			const thumbFile = new File([toBlobPart(result.thumbnail)], "poster.jpg", {
				type: "image/jpeg",
			});
			const uploaded = await uploadImageFile(thumbFile, "thumbnail");
			thumbnailKey = uploaded.key;
			thumbnailPreview = uploaded.url;
		} catch {
			// Poster is optional; the server can still derive one during packaging.
		}
	}

	onProgress?.({ stage: "Done", percent: 100, etaSeconds: 0 });
	return {
		sourceKey,
		variants,
		thumbnailKey,
		thumbnailPreview,
		durationSeconds: result.durationSeconds,
	};
}

/**
 * The desktop equivalent: encode with the bundled native ffmpeg, then upload exactly
 * as the browser path does.
 *
 * Takes a PATH rather than a `File` — the native picker yields one, and ffmpeg reads
 * the source straight off disk, so a multi-gigabyte source is never held in memory
 * during the encode. The upload still reads bytes into memory (same as the browser
 * path); that ceiling is now the source *upload*, not the *encode*, and lifting it
 * means moving the upload into Rust. Documented as a follow-up rather than guessed at.
 *
 * Progress bands match `uploadClientTranscodedVideo` so the UI is identical.
 */
export async function uploadNativeTranscodedVideo(
	path: string,
	onProgress?: (p: VideoJobProgress) => void,
): Promise<ClientVideoUpload> {
	const { transcodeNative, basename } = await import("./native-transcode");
	const { readFile } = await import("@tauri-apps/plugin-fs");

	// ── Encode (0–65%) ──
	const result = await transcodeNative(path, (p) => {
		onProgress?.({
			stage: p.stage,
			percent: Math.round(p.percent * 0.65),
			etaSeconds: p.etaSeconds,
		});
	});

	// ── Upload source (65–80%) ──
	const name = basename(path);
	const sourceBytes = await readFile(path);
	const sourceFile = new File([toBlobPart(sourceBytes)], name, { type: "video/mp4" });
	const sourceKey = await uploadMediaFile(sourceFile, "video", (pct) =>
		onProgress?.({
			stage: "Uploading source",
			percent: 65 + Math.round(pct * 0.15),
			etaSeconds: null,
		}),
	);

	// ── Upload variants (80–97%), sequential for monotonic progress ──
	const variants: UploadedVariant[] = [];
	const span = 17 / Math.max(1, result.variants.length);
	for (let i = 0; i < result.variants.length; i++) {
		const v = result.variants[i];
		const base = 80 + i * span;
		const variantFile = new File([toBlobPart(v.data)], `${v.name}.mp4`, { type: "video/mp4" });
		const key = await uploadMediaFile(variantFile, "video", (pct) =>
			onProgress?.({
				stage: `Uploading ${v.name}`,
				percent: Math.round(base + (pct / 100) * span),
				etaSeconds: null,
			}),
		);
		variants.push({
			name: v.name,
			height: v.height,
			width: v.width,
			bitrate: v.bitrate,
			bandwidth: v.bandwidth,
			key,
		});
	}

	// ── Upload thumbnail (97–100%) ──
	let thumbnailKey = "";
	let thumbnailPreview = "";
	if (result.thumbnail) {
		onProgress?.({ stage: "Uploading thumbnail", percent: 98, etaSeconds: null });
		try {
			const thumbFile = new File([toBlobPart(result.thumbnail)], "poster.jpg", {
				type: "image/jpeg",
			});
			const uploaded = await uploadImageFile(thumbFile, "thumbnail");
			thumbnailKey = uploaded.key;
			thumbnailPreview = uploaded.url;
		} catch {
			// Poster is optional; the server can still derive one during packaging.
		}
	}

	onProgress?.({ stage: "Done", percent: 100, etaSeconds: 0 });
	return {
		sourceKey,
		variants,
		thumbnailKey,
		thumbnailPreview,
		durationSeconds: result.durationSeconds,
	};
}
