import { client } from "./rpc";

/**
 * Upload a media file (video/audio) using presigned URL (S3) or direct upload (local dev).
 * Returns the storage key for the uploaded file.
 */
export async function uploadMediaFile(
	file: File,
	mediaType: "video" | "audio",
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
		key: string;
	};

	if (urlInfo.method === "presigned") {
		// S3 presigned upload — PUT directly to Spaces
		await xhrUpload(urlInfo.uploadUrl, file, "PUT", onProgress);
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
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(method, url);

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
		// Handle relative URLs — use the same base as the RPC client
		const baseUrl =
			typeof location !== "undefined" &&
			(location.hostname === "localhost" ||
				location.hostname === "127.0.0.1")
				? "http://localhost:8000"
				: "";
		const fullUrl = url.startsWith("/") ? `${baseUrl}${url}` : url;
		xhr.open("POST", fullUrl);
		xhr.withCredentials = true;

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
