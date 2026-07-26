// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the live object-storage bucket ACTUALLY allows — read off the bucket, not off
 * this repo's idea of it.
 *
 * The recurring failure mode with Spaces is that the answer lives only in the
 * DigitalOcean dashboard, so the repo can be entirely correct while production is
 * entirely broken, and local dev can never tell you (`STORAGE_BACKEND=local` serves
 * everything unsigned from the API's own origin, so it exercises neither ACLs nor CORS).
 * Two live examples, both found this way and neither visible in code review:
 *
 *   - Presigned uploads carried no ACL, so every object took an undocumented bucket
 *     default. The probe showed the default was already private — a latent gap, not an
 *     exposure — which is what set the priority.
 *   - The bucket's CORS list omitted `studio.anthers.org`, so creator media upload was
 *     simply broken in production. Nobody had noticed because prod had no posts.
 *
 * Read-only by default. `--write-probe` additionally round-trips a throwaway object to
 * answer the question no configuration read can: what ACL does a PUT actually produce?
 *
 *   bun run apps/api/scripts/storage-posture.ts               # inspect config + CORS
 *   bun run apps/api/scripts/storage-posture.ts --write-probe # + real PUT/read/delete
 *
 * Needs SPACES_* in the environment. Point it at prod's bucket to check prod.
 */

import {
	DeleteObjectCommand,
	GetBucketAclCommand,
	GetBucketCorsCommand,
	GetBucketPolicyCommand,
	GetObjectAclCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.SPACES_REGION ?? "nyc3";
const bucket = process.env.SPACES_BUCKET ?? "";
const host = `https://${bucket}.${region}.digitaloceanspaces.com`;
const writeProbe = process.argv.includes("--write-probe");

if (!bucket || !process.env.SPACES_KEY) {
	console.error("SPACES_BUCKET / SPACES_KEY not set — nothing to inspect.");
	process.exit(1);
}

const s3 = new S3Client({
	region,
	endpoint: `https://${region}.digitaloceanspaces.com`,
	credentials: {
		accessKeyId: (process.env.SPACES_KEY ?? "").trim(),
		secretAccessKey: (process.env.SPACES_SECRET ?? "").trim(),
	},
	forcePathStyle: false,
	// Spaces rejects the SDK's default flexible-checksum trailers — same reason as s3.ts.
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});

/**
 * Origins that must be able to reach the bucket from a browser, and why. A presigned
 * upload is a `PUT`, which is never a CORS-simple request; HLS playback is a `GET` via
 * XHR from hls.js. Checking only PUT would pass a config that fixed uploads and left
 * playback broken, so both are probed.
 */
const BROWSER_ORIGINS = [
	["https://anthers.org", "consumer site"],
	["https://www.anthers.org", "www variant"],
	["https://studio.anthers.org", "Creator Studio — performs media uploads"],
	["tauri://localhost", "packaged desktop Studio (raw XHR, so CORS applies)"],
] as const;

let failures = 0;

console.log(`bucket=${bucket} region=${region}\n`);

// ── Bucket-level configuration ───────────────────────────────────────────────
try {
	const acl = await s3.send(new GetBucketAclCommand({ Bucket: bucket }));
	const publicGrants = (acl.Grants ?? []).filter((g) => g.Grantee?.Type === "Group");
	console.log(`bucket ACL: ${publicGrants.length === 0 ? "owner only" : "HAS GROUP GRANTS"}`);
	for (const g of publicGrants) console.log(`   !! ${g.Grantee?.URI} = ${g.Permission}`);
	if (publicGrants.length > 0) failures++;
} catch (err) {
	console.log(`bucket ACL: unreadable — ${(err as Error).message}`);
}

try {
	const pol = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
	console.log(`bucket policy: present\n${pol.Policy}`);
} catch {
	// Note: DO Spaces does NOT implement GetBucketPolicyStatus, so "is this bucket
	// public?" cannot be asked directly — the write probe below is how you find out.
	console.log("bucket policy: none (no prefix-level ACL enforcement)");
}

// ── CORS ─────────────────────────────────────────────────────────────────────
console.log("\n── CORS rules");
const corsOrigins: string[] = [];
try {
	const cors = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
	for (const r of cors.CORSRules ?? []) {
		corsOrigins.push(...(r.AllowedOrigins ?? []));
		console.log(
			`   ${(r.AllowedOrigins ?? []).join(", ")} — methods=${(r.AllowedMethods ?? []).join("/")} headers=${(r.AllowedHeaders ?? []).join(",")}`,
		);
	}
} catch (err) {
	console.log(`   unreadable — ${(err as Error).message}`);
}

console.log("\n── Preflight (what a browser actually gets)");
for (const [origin, label] of BROWSER_ORIGINS) {
	const codes: string[] = [];
	for (const method of ["PUT", "GET"]) {
		const res = await fetch(`${host}/creators/1/videos/originals/posture-probe.mp4`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": method,
				// What the presigned upload sends since the explicit-ACL change.
				"Access-Control-Request-Headers": "content-type,x-amz-acl",
			},
		});
		codes.push(
			`${method}=${res.status}${res.headers.get("access-control-allow-origin") ? "" : "!"}`,
		);
	}
	const ok = codes.every((c) => c.includes("=200") && !c.endsWith("!"));
	if (!ok) failures++;
	console.log(`   ${ok ? "ok  " : "FAIL"} ${origin.padEnd(30)} ${codes.join(" ")}  ${label}`);
}

// A wildcard would make every check above pass for the wrong reason.
if (corsOrigins.includes("*")) {
	console.log("   !! CORS allows '*' — every origin passes, including ones we don't run");
	failures++;
}

// ── What a PUT actually produces ─────────────────────────────────────────────
if (writeProbe) {
	console.log("\n── Write probe (throwaway objects, deleted immediately)");
	const base = `.posture-probe/${crypto.randomUUID()}`;

	for (const [label, acl] of [
		["no ACL (the old presign behaviour)", undefined],
		["explicit private", "private"],
	] as const) {
		const key = `${base}.${acl ?? "none"}.txt`;
		const url = await getSignedUrl(
			s3,
			new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "text/plain", ACL: acl }),
			{ expiresIn: 120 },
		);
		const headers: Record<string, string> = { "content-type": "text/plain" };
		if (acl) headers["x-amz-acl"] = acl;
		const put = await fetch(url, { method: "PUT", body: "posture probe", headers });
		if (!put.ok) {
			console.log(`   FAIL ${label} — PUT ${put.status}`);
			failures++;
			continue;
		}
		const objAcl = await s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: key }));
		const worldReadable = (objAcl.Grants ?? []).some((g) => g.Grantee?.Type === "Group");
		const anon = await fetch(`${host}/${key}`);
		if (worldReadable || anon.status === 200) failures++;
		console.log(
			`   ${worldReadable || anon.status === 200 ? "FAIL" : "ok  "} ${label.padEnd(34)} anonymous GET ${anon.status} (200 = world readable)`,
		);
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	}

	// The uncomfortable one: a presigned URL signs only `host`, so the CLIENT picks the
	// ACL and Spaces honours it over the one the server signed. Only a bucket policy can
	// enforce the posture — this line is here so that stays visible rather than assumed.
	const key = `${base}.client-override.txt`;
	const url = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "text/plain", ACL: "private" }),
		{ expiresIn: 120 },
	);
	const put = await fetch(url, {
		method: "PUT",
		body: "posture probe",
		headers: { "content-type": "text/plain", "x-amz-acl": "public-read" },
	});
	if (put.ok) {
		const anon = await fetch(`${host}/${key}`);
		console.log(
			`   ${anon.status === 200 ? "note" : "ok  "} client overrode server ACL      anonymous GET ${anon.status} (200 = server ACL is intent, not enforcement)`,
		);
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	}
}

console.log(`\n${failures === 0 ? "No problems found." : `${failures} problem(s) found.`}`);
process.exit(failures === 0 ? 0 : 1);
