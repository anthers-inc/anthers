// SPDX-License-Identifier: Apache-2.0
/**
 * The multipart upload session's routes, through `app.fetch` — the surface beside
 * `upload-sessions.test.ts`'s service-level contract. What only a route can answer:
 * auth (401 where no session), validation (400), the local-mode direct hand-back,
 * the local-mode refusal for a session body, and every service refusal's status and
 * body shape as Hono maps it.
 *
 * ⚠️ **The session flow only exists under `STORAGE_BACKEND=s3`, and that environment
 * cannot be set inside a suite** — one `bun test` invocation is one process, sharing
 * `process.env` with every sibling file loaded after it. So this file is two roles,
 * the shape `video-original.test.ts` carries: when loaded normally it DRIVES, spawning
 * a child `bun test` of this same file under the s3 environment, and the child runs the
 * S3-mode assertions through a stand-in the child set up first.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/** The mode flag the driver sets for the child, and only the child sees set. */
const MODE_ENV = "ANTERS_TEST_S3_UPLOAD_SESSIONS";

if (process.env[MODE_ENV] === "1") {
	await runSessionModeSuite();
} else {
	const { purgeAccountsCreatedHere } = await import("./cleanup");
	// Module scope, as every suite that uses it expects — inside an `it`, its own
	// beforeAll/afterAll registration has no describe to hang on.
	purgeAccountsCreatedHere();

	describe("the local-mode session surface (driving alongside the child)", () => {
		it("runs the s3-mode suite in a child process, so its storage environment cannot reach a sibling file", async () => {
			const proc = Bun.spawn(["bun", "test", import.meta.path], {
				// The api workspace's own bunfig, whose preload brings the child its session.
				cwd: join(import.meta.dir, "../.."),
				env: { ...process.env, [MODE_ENV]: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (stdout) console.log(`child stdout:\n${stdout}`);
			if (stderr) console.log(`child stderr:\n${stderr}`);
			expect(code, "the s3-mode child must exit green; see its output above").toBe(0);
		}, 180_000);

		it("hands the direct endpoint back where storage is local, and refuses what no account sent", async () => {
			const app = (await import("../index")).default;
			const { createAccount } = await import("./account-fixture");

			const start = `/api/content/media-upload/session/start`;
			const body = {
				filename: "take.mp4",
				contentType: "video/mp4",
				mediaType: "video",
				size: 64 * 1024 * 1024,
			};

			// No session is an answer no route gives. The direct hand-back is the only door.
			const unauth = await app.fetch(
				new Request(`http://localhost${start}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: ORIGIN },
					body: JSON.stringify(body),
				}),
			);
			expect(unauth.status).toBe(401);

			const { cookie } = await createAccount(`upsessLocal_${Date.now().toString(36)}`);
			const local = await app.fetch(
				new Request(`http://localhost${start}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
					body: JSON.stringify(body),
				}),
			);
			expect(local.status).toBe(200);
			const plan = (await local.json()) as { method: string; sessionId: string | null };
			expect(plan.method).toBe("direct");
			expect(plan.sessionId).toBeNull();

			// A plan with no file in it is no plan at all — the schema refuses it before any door.
			const invalid = await app.fetch(
				new Request(`http://localhost${start}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
					body: JSON.stringify({ ...body, size: 0 }),
				}),
			);
			expect(invalid.status).toBe(400);
		});
	});
}

const ORIGIN = "http://localhost:3000";

/** The body of the suite, run only where the s3 environment is in force. */
async function runSessionModeSuite(): Promise<void> {
	const { afterAll, beforeAll, describe, expect, it } = await import("bun:test");

	/**
	 * A stand-in speaking enough of the S3 multipart shapes that the SDK's calls answer.
	 * Real part sizes are not enforced — a part of 12 bytes PUTs against the same
	 * presigned URL a 64 MiB part would, and that bound is the S3 implementation's
	 * business, not this surface's. ETags are the quotes-and-all strings a real answer
	 * carries, so the completion's identity comparison reads exactly what a browser's
	 * `getResponseHeader("ETag")` would.
	 */
	const heldParts = new Map<string, Map<number, string>>();
	const completedUploads = new Set<string>();
	let uploadSeq = 0;

	const xml = (body: string) =>
		new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } });

	const storageStandIn = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname.replace(/^\//, "");
			const key = path.slice(path.indexOf("/") + 1);
			const query = url.searchParams;
			const method = req.method;

			if (method === "POST" && query.has("uploads")) {
				const uploadId = `up_${++uploadSeq}`;
				heldParts.set(uploadId, new Map());
				return xml(
					`<InitiateMultipartUploadResult><Bucket>${url.pathname.split("/")[1]}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
				);
			}
			if (method === "PUT" && query.has("partNumber")) {
				const uploadId = query.get("uploadId") ?? "";
				const number = Number(query.get("partNumber"));
				const etag = `"etag-${number}"`;
				heldParts.get(uploadId)?.set(number, etag);
				return new Response(null, { status: 200, headers: { ETag: etag } });
			}
			if (method === "GET" && query.has("uploadId")) {
				const held = heldParts.get(query.get("uploadId") ?? "") ?? new Map();
				const parts = [...held]
					.map(
						([number, etag]) =>
							`<Part><ETag>${etag}</ETag><PartNumber>${number}</PartNumber><Size>${number}</Size></Part>`,
					)
					.join("");
				return xml(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
			}
			if (method === "POST" && query.has("uploadId")) {
				completedUploads.add(query.get("uploadId") ?? "");
				return xml(
					`<CompleteMultipartUploadResult><Location>https://storage.test/${key}</Location><Bucket>bucket</Bucket><Key>${key}</Key><ETag>"assembled"</ETag></CompleteMultipartUploadResult>`,
				);
			}
			if (method === "DELETE" && query.has("uploadId")) {
				heldParts.delete(query.get("uploadId") ?? "");
				return new Response(null, { status: 204 });
			}
			return new Response("the stand-in does not answer this shape", { status: 400 });
		},
	});

	// Nothing from the app tree is imported first: `storage/index` reads the `STORAGE_*`
	// environment once at import, and the client is built with it — so the stand-in is
	// up and the env is final before the first module that reaches either. Importing the
	// upload-session service or the app ahead of them builds the LOCAL backend, and
	// every session route quietly answers `direct`.
	process.env.STORAGE_BACKEND = "s3";
	process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${storageStandIn.port}`;
	process.env.STORAGE_REGION = "anthers-test";
	process.env.STORAGE_BUCKET = "anthers-test-bucket";
	process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.anthers.org";
	process.env.STORAGE_KEY = "test-key";
	process.env.STORAGE_SECRET = "test-secret";
	process.env.STORAGE_FORCE_PATH_STYLE = "true";

	const { db } = await import("@anthers/db/client");
	const { mediaUploadSessions } = await import("@anthers/db/schema");
	const { eq } = await import("drizzle-orm");
	const { createAccount } = await import("./account-fixture");
	const { purgeAccountsCreatedHere } = await import("./cleanup");
	const { DB_SETUP_TIMEOUT } = await import("./setup-timeouts.js");
	const { UPLOAD_PART_SIZE } = await import("../services/upload-sessions.js");
	const app = (await import("../index")).default;

	const BASE = "http://localhost/api/content/media-upload";
	const BODY = {
		filename: "take.mp4",
		contentType: "video/mp4",
		mediaType: "video" as const,
		size: UPLOAD_PART_SIZE * 2 + 1024,
	};
	function req(path = "/session/start", options?: { auth?: string | null; body?: unknown }) {
		return app.fetch(
			new Request(BASE + path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: ORIGIN,
					...(options?.auth ? { Cookie: options.auth } : {}),
				},
				body: JSON.stringify(options?.body ?? BODY),
			}),
		);
	}

	purgeAccountsCreatedHere();
	afterAll(() => storageStandIn.stop(true));

	let creatorCookie = "";
	let creatorId = 0;
	let otherCreatorCookie = "";

	beforeAll(async () => {
		const creator = await createAccount(`upsessR_c_${Date.now().toString(36)}`);
		creatorId = creator.userId;
		creatorCookie = creator.cookie;
		const other = await createAccount(`upsessR_b_${Date.now().toString(36)}`);
		otherCreatorCookie = other.cookie;
	}, DB_SETUP_TIMEOUT);

	describe("opening a session", () => {
		it("answers a session whose plan is the part split, under the creator's own prefix", async () => {
			const res = await req("/session/start", { auth: creatorCookie });
			expect(res.status).toBe(201);
			const plan = (await res.json()) as {
				method: string;
				sessionId: string;
				key: string;
				partSize: number;
				parts: Array<{ number: number; url: string }>;
			};
			expect(plan.method).toBe("session");
			expect(plan.sessionId).toMatch(/^[0-9a-f-]{36}$/);
			expect(plan.key).toMatch(new RegExp(`^creators/${creatorId}/videos/originals/.*\\.mp4$`));
			expect(plan.partSize).toBe(UPLOAD_PART_SIZE);
			expect(plan.parts).toHaveLength(3);
			for (const [i, part] of plan.parts.entries()) {
				expect(part.number).toBe(i + 1);
				expect(part.url).toContain(plan.key);
				expect(part.url).toContain(`partNumber=${i + 1}`);
				expect(part.url).toContain("X-Amz-Signature");
			}

			// The plan is in the database under its creator, open, and the sweeper's
			// business if it is never completed.
			const [row] = await db
				.select()
				.from(mediaUploadSessions)
				.where(eq(mediaUploadSessions.id, plan.sessionId));
			expect(row.status).toBe("open");
			expect(row.partCount).toBe(3);
		});

		it("answers nothing without an account, and refuses a plan that asks for nothing", async () => {
			expect((await req("/session/start", { auth: null })).status).toBe(401);
			expect(
				(await req("/session/start", { auth: creatorCookie, body: { ...BODY, size: 0 } })).status,
			).toBe(400);
		});
	});

	describe("completion and its refusals", () => {
		it("completes a fully-PUT plan once, and never twice", async () => {
			const res = await req("/session/start", { auth: creatorCookie });
			const plan = (await res.json()) as {
				sessionId: string;
				key: string;
				parts: Array<{ number: number; url: string }>;
			};

			// The client PUTs against its plan, out of order, and reads each answer's ETag.
			for (const part of [2, 1]) {
				const put = await fetch(plan.parts[part - 1].url, { method: "PUT", body: "bytes" });
				expect(put.ok).toBe(true);
			}
			const thirdUrl = plan.parts[2].url; // the plan's trailing, smaller part
			const put = await fetch(thirdUrl, { method: "PUT", body: "bytes" });
			const thirdEtag = put.headers.get("ETag");

			const complete = await req("/session/complete", {
				auth: creatorCookie,
				body: {
					sessionId: plan.sessionId,
					parts: [
						{ number: 2, etag: '"etag-2"' },
						{ number: 1, etag: '"etag-1"' },
						{ number: 3, etag: thirdEtag },
					],
					clientSha256: `sha-${"a".repeat(64)}`,
				},
			});
			expect(complete.status).toBe(200);
			expect(((await complete.json()) as { key: string }).key).toBe(plan.key);

			const [row] = await db
				.select()
				.from(mediaUploadSessions)
				.where(eq(mediaUploadSessions.id, plan.sessionId));
			expect(row.status).toBe("completed");
			expect(row.clientSha256).toBe(`sha-${"a".repeat(64)}`);
			expect(completedUploads.has(row.uploadId)).toBe(true);

			// The second ask meets a session that already ended.
			const again = await req("/session/complete", {
				auth: creatorCookie,
				body: { sessionId: plan.sessionId, parts: [{ number: 1, etag: '"etag-1"' }] },
			});
			expect(again.status).toBe(409);
		});

		it("refuses, as 409, a part whose ETag is not its upload's answer and a plan with a hole", async () => {
			const open = async () => {
				const res = await req("/session/start", { auth: creatorCookie });
				const plan = (await res.json()) as {
					sessionId: string;
					parts: Array<{ number: number; url: string }>;
				};
				for (const part of plan.parts) {
					await fetch(part.url, { method: "PUT", body: "bytes" });
				}
				return plan;
			};

			const withWrongEtag = await open();
			const refused = await req("/session/complete", {
				auth: creatorCookie,
				body: {
					sessionId: withWrongEtag.sessionId,
					parts: withWrongEtag.parts.map((p) => ({ number: p.number, etag: '"other"' })),
				},
			});
			expect(refused.status).toBe(409);

			const withHole = await open();
			const holey = await req("/session/complete", {
				auth: creatorCookie,
				body: {
					sessionId: withHole.sessionId,
					parts: withHole.parts
						.map((part) => ({ number: part.number, etag: `"etag-${part.number}"` }))
						.slice(0, 2),
				},
			});
			expect(holey.status).toBe(409);
			const body = (await holey.json()) as { error?: string };
			expect(body.error).toContain("3 parts");
		});

		it("another creator's session is a 404 through the route, and an unknown id is too", async () => {
			const res = await req("/session/start", { auth: creatorCookie });
			const plan = (await res.json()) as { sessionId: string };
			// Ownership is the first gate on completion: no storage call answers these.
			const foreign = await req("/session/complete", {
				auth: otherCreatorCookie,
				body: { sessionId: plan.sessionId, parts: [{ number: 1, etag: '"etag-1"' }] },
			});
			expect(foreign.status).toBe(404);
			const unknown = await req("/session/complete", {
				auth: creatorCookie,
				body: { sessionId: crypto.randomUUID(), parts: [{ number: 1, etag: '"etag-1"' }] },
			});
			expect(unknown.status).toBe(404);
		});
	});

	describe("resume — a relaunch rekeys on the digest", () => {
		it("a second start with the digest hands back the open session it names, and the held part is not resent", async () => {
			const digest = `sha-${"b".repeat(64)}`;
			const first = await req("/session/start", {
				auth: creatorCookie,
				body: { ...BODY, clientSha256: digest },
			});
			expect(first.status).toBe(201);
			const plan1 = (await first.json()) as {
				sessionId: string;
				parts: Array<{ number: number; url: string }>;
				held: number[];
			};
			expect(plan1.held).toEqual([]);

			// Only part 1 goes up before the "relaunch"; the digest is all the next start knows.
			await fetch(plan1.parts[0].url, { method: "PUT", body: "bytes" });
			const second = await req("/session/start", {
				auth: creatorCookie,
				body: { ...BODY, clientSha256: digest },
			});
			expect(second.status).toBe(201);
			const plan2 = (await second.json()) as {
				sessionId: string;
				parts: Array<{ number: number; url: string }>;
				held: number[];
			};
			expect(plan2.sessionId).toBe(plan1.sessionId);
			expect(plan2.held).toEqual([1]);

			// Parts 2 and 3 go up; the held part is reported bare — its ETag is the
			// backend's listing to supply, and the completion accepts exactly that.
			for (const part of plan2.parts.slice(1)) {
				const put = await fetch(part.url, { method: "PUT", body: "bytes" });
				expect(put.ok).toBe(true);
			}
			const complete = await req("/session/complete", {
				auth: creatorCookie,
				body: {
					sessionId: plan2.sessionId,
					parts: [{ number: 1 }, { number: 2, etag: '"etag-2"' }, { number: 3, etag: '"etag-3"' }],
					clientSha256: digest,
				},
			});
			expect(complete.status).toBe(200);
		});

		it("a completion naming a digest other than the session's own is refused through the route", async () => {
			const digest = `sha-${"e".repeat(64)}`;
			const res = await req("/session/start", {
				auth: creatorCookie,
				body: { ...BODY, clientSha256: digest },
			});
			const plan = (await res.json()) as {
				sessionId: string;
				parts: Array<{ number: number; url: string }>;
			};
			for (const part of plan.parts) {
				await fetch(part.url, { method: "PUT", body: "bytes" });
			}
			const mismatch = await req("/session/complete", {
				auth: creatorCookie,
				body: {
					sessionId: plan.sessionId,
					parts: plan.parts.map((p) => ({ number: p.number, etag: `"etag-${p.number}"` })),
					clientSha256: `sha-${"f".repeat(64)}`,
				},
			});
			expect(mismatch.status).toBe(409);
			const body = (await mismatch.json()) as { error?: string };
			expect(body.error).toContain("not the one this upload session was opened for");
		});
	});

	describe("abandoning a session", () => {
		it("frees a session's parts on the creator's say-so, and a repeat abort is a no-op", async () => {
			const res = await req("/session/start", { auth: creatorCookie });
			const plan = (await res.json()) as {
				sessionId: string;
				parts: Array<{ number: number; url: string }>;
			};
			for (const part of plan.parts) {
				await fetch(part.url, { method: "PUT", body: "bytes" });
			}

			const abort = await req("/session/abort", {
				auth: creatorCookie,
				body: { sessionId: plan.sessionId },
			});
			expect(abort.status).toBe(204);
			const [row] = await db
				.select()
				.from(mediaUploadSessions)
				.where(eq(mediaUploadSessions.id, plan.sessionId));
			expect(row.status).toBe("aborted");
			expect(heldParts.get(row.uploadId)?.size ?? 0).toBe(0);

			const again = await req("/session/abort", {
				auth: creatorCookie,
				body: { sessionId: plan.sessionId },
			});
			expect(again.status).toBe(204);
		});
	});
}
