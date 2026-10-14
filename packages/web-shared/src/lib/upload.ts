// SPDX-License-Identifier: Apache-2.0
import { createSHA256 } from "hash-wasm";
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
 * ⚠️ **Every session upload carries the file's SHA-256, read before anything goes up.**
 * The digest does two jobs at once: it keys a RESUME (a start that names a digest the
 * creator still holds an open session for is answered with that session's plan, the
 * parts it already holds named) and it completes the session, so the object's identity
 * is client-vouched end to end. A digest read before the upload means a multi-
 * gigabyte file is read through once up front — the honest cost of a resume bound
 * to the bytes rather than to a tab.
 *
 * ⚠️ **A failed attempt leaves the session open.** The parts the backend holds persist
 * and a retry re-keys on the digest, re-asks the plan (fresh part addresses, the old
 * list having a day's life), and sends only what is missing. The abandonment sweeper's
 * grace is the bound for an attempt nobody ever retries.
 */

/** How many parts go on the wire at once. A part is 64 MiB; three is a wire full of
 * throughput without a spike that starves a shared connection. */
const PART_CONCURRENCY = 3;

/** The whole file's SHA-256, read in slices. Web Crypto wants the entire buffer, which
 * a multi-gigabyte file cannot offer; a chained hasher takes slices instead and yields
 * between them, so the page stays alive while a read pass ahead of the upload runs. */
export async function wholeFileSha256Hex(file: File, signal?: AbortSignal): Promise<string> {
	const hasher = await createSHA256();
	hasher.init();
	const CHUNK = 8 * 1024 * 1024;
	for (let at = 0; at < file.size; at += CHUNK) {
		// A cancel checks between slices: it stops the read pass as a whole, at chunk
		// granularity, which is as close as this loop can honestly come.
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const bytes = await file.slice(at, Math.min(at + CHUNK, file.size)).arrayBuffer();
		hasher.update(new Uint8Array(bytes));
	}
	return hasher.digest("hex");
}

export async function uploadMediaFile(
	file: File,
	mediaType: "video" | "audio" | "asset",
	onProgress?: (percent: number | null) => void,
	signal?: AbortSignal,
): Promise<string> {
	// The digest comes first — it is the resume key, so it must exist before the plan is
	// asked for. No progress is reportable yet, so the caller sees the indeterminate bar
	// rather than a misleading 0%.
	onProgress?.(null);
	const digest = `sha-${await wholeFileSha256Hex(file, signal)}`;

	const res = await client.api.content["media-upload"].session.start.$post({
		json: {
			filename: file.name,
			contentType: file.type,
			mediaType,
			size: file.size,
			clientSha256: digest,
		},
	});
	if (!res.ok) throw new Error("The upload could not start");
	const plan = (await res.json()) as {
		method: "session" | "direct";
		sessionId: string | null;
		key?: string;
		partSize?: number;
		parts?: Array<{ number: number; url: string }>;
		held?: number[];
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
			signal,
		);
		return result.key;
	}

	return uploadSessionPlan(
		file,
		{
			sessionId: plan.sessionId ?? "",
			partSize: plan.partSize ?? 0,
			parts: plan.parts ?? [],
			held: plan.held ?? [],
			digest,
		},
		onProgress,
		signal,
	);
}

/** How one part goes up — the XHR PUT by default; one half of the suite's injection seam. */
export type SessionPartPutter = (
	url: string,
	blob: Blob,
	onLoaded: (chunkLoaded: number) => void,
	signal?: AbortSignal,
) => Promise<{ etag: string | null; bytes: number }>;

/** The suite's injection seam around the network: how a part goes up and how the
 *  session finishes. Defaults are the XHR part PUT and the RPC `session.complete`. */
export interface SessionRunnerIo {
	put: SessionPartPutter;
	complete: (
		parts: Array<{ number: number; etag?: string }>,
		digest: string,
		sessionId: string,
	) => Promise<string>;
}

/** The session plan's runner, exported for its suite: the held-part accounting, the
 *  concurrency, the retry loop and the whole-file progress arithmetic all live here. */
export async function uploadSessionPlan(
	file: File,
	plan: {
		sessionId: string;
		partSize: number;
		parts: Array<{ number: number; url: string }>;
		held: number[];
		digest: string;
	},
	onProgress?: (percent: number | null) => void,
	signal?: AbortSignal,
	io: SessionRunnerIo = {
		put: xhrUploadPart,
		complete: async (parts, digest, sessionId) => {
			const complete = await client.api.content[`media-upload`].session.complete.$post({
				json: { sessionId, parts, clientSha256: digest },
			});
			if (!complete.ok) {
				const body = (await complete.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `The upload refused to complete (${complete.status})`);
			}
			const { key } = (await complete.json()) as { key: string };
			return key;
		},
	},
): Promise<string> {
	// An empty plan is a protocol bug the server must never produce — a session with a
	// sessionId and no parts is a session that completes into nothing.
	if (!plan.sessionId || plan.parts.length === 0) {
		throw new Error("The server's upload plan was empty");
	}
	const held = new Set(plan.held);
	// The parts of a resumed attempt the backend already holds are recorded, never
	// re-sent — their ETags are the backend listing's to supply, which completion
	// consults where the client could not have read one.
	const uploaded = new Array<{ number: number; etag?: string }>(plan.parts.length);
	for (const number of held) uploaded[number - 1] = { number };
	const heldBytes = [...held].reduce(
		(bytes, number) => bytes + Math.min(plan.partSize, file.size - (number - 1) * plan.partSize),
		0,
	);
	let deliveredBytes = heldBytes;
	let aborted = false;
	// A resumed attempt reports where it already is, not a restarted 0%.
	if (heldBytes > 0) onProgress?.(percentOf(deliveredBytes, file.size));

	try {
		const queue = plan.parts.filter((part) => !held.has(part.number));
		const workers = Array.from({ length: PART_CONCURRENCY }, async () => {
			for (;;) {
				if (signal?.aborted || aborted) return;
				const next = queue.shift();
				if (!next || aborted) return;
				const end = Math.min(next.number * plan.partSize, file.size);
				const blob = file.slice((next.number - 1) * plan.partSize, end);

				for (let attempt = 1; attempt <= 3; attempt++) {
					try {
						const { etag, bytes } = await io.put(
							next.url,
							blob,
							(chunkLoaded) => {
								if (onProgress) {
									onProgress(
										// Progress is whole-file honest: delivered = parts done +
										// the in-flight part's own loaded counter.
										//
										// 🚨 `bytes` must NOT join this sum. It is named by this very
										// destructuring, which is still awaiting — reading it here was
										// a temporal-dead-zone throw on every progress event (the
										// production bundle's "Cannot access 'K' before
										// initialization", browser error event 5359), and it also
										// double-counted: a part's full size would be added before
										// that part had finished. The completed parts sit in
										// `deliveredBytes`, and the in-flight one tells its own
										// loaded counter.
										percentOf(deliveredBytes + chunkLoaded, file.size),
									);
								}
							},
							signal,
						);
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

		const key = await io.complete(
			uploaded.filter((p) => p != null),
			plan.digest,
			plan.sessionId,
		);
		if (onProgress) onProgress(100);
		return key;
	} catch (error) {
		// The session STAYS OPEN: its held parts are exactly what a retry resumes, keyed
		// on the digest read before either attempt sent anything. The abandonment
		// sweeper's grace bounds an attempt nobody ever retried, and a creator who picks
		// a different file just orphans the open one to that same sweeper.
		aborted = true;
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
	signal?: AbortSignal,
): Promise<{ etag: string | null; bytes: number }> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		// A canceled upload aborts its own requests on the wire; the rejection is the
		// ordinary error path, and the session stays open for the sweeper.
		signal?.addEventListener("abort", () => xhr.abort());
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
	signal?: AbortSignal,
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
		signal?.addEventListener("abort", () => xhr.abort());

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
