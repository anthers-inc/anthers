// SPDX-License-Identifier: Apache-2.0
/**
 * The multipart upload session's surface, beside the presign and direct routes that
 * remain the door for images, small files and local dev.
 *
 * The shapes the client sees:
 *
 * - `start` — one call, one answer. In S3 mode: a session carrying the **whole part
 *   plan** (every part's presigned PUT address minted in the same answer, a day's life
 *   apiece — the client re-asks rather than carrying a stale plan). In local mode the
 *   same `direct` hand-back the presign route gives, because local uploads are small.
 * - `complete` — the parts the client put, each with the ETag its own PUT answered;
 *   the service verifies coverage and identity before asking the backend to assemble.
 * - `abort` — a client abandoning mid-send frees the part traffic it already put.
 *
 * Every route is the creator's own session or nothing: the row is found under the
 * requesting user's id, and an unknown session id is a 404 that says no more than that.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { isLocalStorage } from "../services/storage/index.js";
import {
	abortUploadSession,
	completeUploadSession,
	SessionCompleteError,
	startUploadSession,
} from "../services/upload-sessions.js";

export const mediaUploadSessionRoutes = new Hono()
	.post(
		"/session/start",
		requireAuth,
		zValidator(
			"json",
			z.object({
				filename: z.string().min(1).max(255),
				contentType: z.string().min(1).max(100),
				mediaType: z.enum(["video", "audio", "asset"]),
				/** The file's full size — what the part plan is built from. */
				size: z.number().int().min(1),
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const user = c.get("user");

			// Local mode answers the same `direct` the presign route answers: no sessions
			// exist here, and the client's transport falls through to the direct endpoint.
			if (isLocalStorage) {
				return c.json({ method: "direct" as const, sessionId: null });
			}
			const session = await startUploadSession(user.id, input);
			return c.json({ method: "session" as const, ...session }, 201);
		},
	)

	.post(
		"/session/complete",
		requireAuth,
		zValidator(
			"json",
			z.object({
				sessionId: z.string().uuid(),
				/**
				 * Every part the client PUT, with the ETag the PUT's own response carried —
				 * the identity that lets completion prove what it is assembling.
				 */
				parts: z
					.array(
						z.object({
							number: z.number().int().min(1),
							// ⚠️ Optional on purpose: whether the storage answers the ETag across
							// the bucket's CORS decides if the client can vouch a part's
							// identity (`getResponseHeader` reads null where CORS does not
							// expose it). Present → the completion's identity gate; absent →
							// the structural gate alone (exact coverage) still holds.
							etag: z.string().min(1).optional(),
						}),
					)
					.min(1),
				/** The digest the client streamed while sending; recorded, not re-computed. */
				clientSha256: z
					.string()
					.regex(/^sha-[0-9a-f]{64}$/)
					.optional(),
			}),
		),
		async (c) => {
			const { sessionId, parts, clientSha256 } = c.req.valid("json");
			const user = c.get("user");
			try {
				const result = await completeUploadSession(user.id, sessionId, parts, clientSha256 ?? null);
				return c.json(result, 200);
			} catch (error) {
				if (error instanceof SessionCompleteError) {
					return c.json({ error: error.message }, error.status as ContentfulStatusCode);
				}
				throw error;
			}
		},
	)

	.post(
		"/session/abort",
		requireAuth,
		zValidator("json", z.object({ sessionId: z.string().uuid() })),
		async (c) => {
			const { sessionId } = c.req.valid("json");
			const user = c.get("user");
			try {
				await abortUploadSession(user.id, sessionId);
				return c.body(null, 204);
			} catch (error) {
				if (error instanceof SessionCompleteError) {
					return c.json({ error: error.message }, error.status as ContentfulStatusCode);
				}
				throw error;
			}
		},
	);
