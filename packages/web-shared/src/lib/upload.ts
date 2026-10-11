// SPDX-License-Identifier: Apache-2.0
import { apiAuthHeaders, apiBaseUrl, apiSendsCookies, client } from "./rpc";

/**
 * Upload a media file and return its storage key.
 *
 * The server owns the door policy, not the client: `session/start` answers
 * `"session"` — a resumable multipart plan (each part against its own presigned
 * address, three at a time by wire) — or `"direct"`, the whole-file hand-off local dev
 * and small files ride. The client executes whichever it is given and never re-asks.
 *
 * Uploading is all this module does: the source goes up as-is and the server processes
 * it. On-device encoding — a browser `ffmpeg.wasm` ladder and a desktop native one —
 * lived here until 2026-08-17 and was removed because it did not work; it returns with
 * the desktop's pre-process step, which produces one upload pack uploaded deliberately.
 *
 * ⚠️ **A failed part abandons the whole attempt, deliberately.** The parts the backend
 * holds are freed by the abandonment sweeper, and a retry is a fresh session with a
 * fresh plan. Byte-level resume of a half-finished attempt (the completed parts persist
 * and are re-named into the new session) is the follow-up leg — the sweeper's grace
 * makes the first cut's cost bounded, not zero.
 */

/** How many parts go on the wire at once. A part is 64 MiB; three is a wire full of
 * throughput without a spike that starves a shared connection. */
const PART_CONCURRENCY = 3;

export async function uploadMediaFile(
	file: File,
	mediaType: "video" | "audio" | "asset",
	onProgress?: (percent: number) => void,
): Promise<string> {
	const res = await client.api.content["media-upload"].session.start.$post({
		json: { filename: file.name, contentType: file.type, mediaType, size: file.size },
	});
	if (!res.ok) throw new Error("The upload could not start");
	const plan = (await res.json()) as {
		method: "session" | "direct";
		sessionId: string | null;
		key?: string;
		partSize?: number;
		parts?: Array<{ number: number; url: string }>;
	};

	if (plan.method === "direct") {
		// Local mode: the whole file rides the direct endpoint in one form post.
		const formData = new FormData();
		formData.append("file", file);
		formData.append("mediaType", mediaType);
		const result = await xhrUploadFormData<{ key: string }>(
			"/api/content/media-upload/direct",
			formData,
			onProgress,
		);
		return result.key;
	}

	return uploadSessionPlan(
		file,
		{
			sessionId: plan.sessionId ?? "",
			partSize: plan.partSize ?? 0,
			parts: plan.parts ?? [],
		},
		onProgress,
	);
}

async function uploadSessionPlan(
	file: File,
	plan: { sessionId: string; partSize: number; parts: Array<{ number: number; url: string }> },
	onProgress?: (percent: number) => void,
): Promise<string> {
	// An empty plan is a protocol bug the server must never produce — a session with a
	// sessionId and no parts is a session that completes into nothing.
	if (!plan.sessionId || plan.parts.length === 0) {
		throw new Error("The server's upload plan was empty");
	}
	const uploaded = new Array<{ number: number; etag?: string }>(plan.parts.length);
	let deliveredBytes = 0;
	let aborted = false;

	try {
		const queue = [...plan.parts];
		const workers = Array.from({ length: PART_CONCURRENCY }, async () => {
			for (;;) {
				const next = queue.shift();
				if (!next || aborted) return;
				const end = Math.min(next.number * plan.partSize, file.size);
				const blob = file.slice((next.number - 1) * plan.partSize, end);

				for (let attempt = 1; attempt <= 3; attempt++) {
					try {
						const { etag, bytes } = await xhrUploadPart(next.url, blob, (chunkLoaded) => {
							if (onProgress) {
								onProgress(
									// Progress is whole-file honest: delivered = parts done +
									// the in-flight part's own loaded counter.
									percentOf(deliveredBytes + bytes + chunkLoaded, file.size),
								);
							}
						});
						uploaded[next.number - 1] = { number: next.number, ...(etag ? { etag } : {}) };
						deliveredBytes += bytes;
						break;
					} catch (error) {
						if (attempt === 3) throw error;
					}
				}
			}
		});
		await Promise.all(workers);

		const complete = await client.api.content["media-upload"].session.complete.$post({
			json: {
				sessionId: plan.sessionId,
				parts: uploaded.filter((p) => p != null),
			},
		});
		if (!complete.ok) {
			const body = (await complete.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? `The upload refused to complete (${complete.status})`);
		}
		const { key } = (await complete.json()) as { key: string };
		if (onProgress) onProgress(100);
		return key;
	} catch (error) {
		// Tell the server the session is dead, so the sweeper has nothing to wait out
		// and the parts are freed now rather than in three days.
		aborted = true;
		void client.api.content["media-upload"].session.abort
			.$post({ json: { sessionId: plan.sessionId } })
			.catch(() => {});
		throw error;
	}
}

function percentOf(bytes: number, total: number): number {
	return total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 100;
}

/** One part's PUT, with whole-part progress — resolves to the answer's ETag when the
 * response carries it past CORS. */
function xhrUploadPart(
	url: string,
	blob: Blob,
	onLoaded: (chunkLoaded: number) => void,
): Promise<{ etag: string | null; bytes: number }> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) onLoaded(e.loaded);
		});
		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve({ etag: xhr.getResponseHeader("ETag"), bytes: blob.size });
			} else {
				reject(new Error(`Part upload failed with status ${xhr.status}`));
			}
		});
		xhr.addEventListener("error", () => reject(new Error("Part upload failed")));
		xhr.send(blob);
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
