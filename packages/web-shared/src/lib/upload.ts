// SPDX-License-Identifier: AGPL-3.0-or-later
import { apiAuthHeaders, apiBaseUrl, apiSendsCookies, client } from "./rpc";

/**
 * Upload a media file (video/audio/asset) using presigned URL (S3) or direct upload (local dev).
 * Returns the storage key for the uploaded file.
 *
 * Uploading is all this module does: the source goes up as-is and the server processes
 * it. On-device encoding — a browser `ffmpeg.wasm` ladder and a desktop native one, both
 * uploading pre-encoded variants for the server to remux — lived here until 2026-08-17
 * and was removed because it did not work. It returns with the desktop app's pre-process
 * step, which produces one upload pack the creator uploads deliberately rather than an
 * encode the upload dialog performs invisibly.
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
