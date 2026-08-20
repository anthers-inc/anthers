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
 * Reads STORAGE_* through the app's own resolveStorageConfig(), so it always inspects the
 * same place the application talks to. Point it at prod's environment to check prod.
 *
 * ⚠️ On Cloudflare R2 the bucket-ACL and CORS reads return AccessDenied under an
 * "Object Read & Write" token — correctly, since the app's runtime credential should not be
 * able to reconfigure its own bucket. Those sections report that rather than failing, and
 * the --write-probe half (which is the part that answers what a PUT actually produces) works
 * regardless.
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
import { resolveStorageConfig } from "../src/services/storage/config.js";

/**
 * Configuration comes from `resolveStorageConfig()` — the same resolver the application
 * uses — rather than being read out of the environment a second time here.
 *
 * It used to read `SPACES_*` directly and compose a DigitalOcean host, which meant this
 * probe could disagree with the app about where storage even *is*. That is a bad property
 * in the one tool whose job is to tell you what production actually looks like, and it
 * became an outright bug when the app moved to R2 while this file still pointed at Spaces.
 */
const config = resolveStorageConfig();
const writeProbe = process.argv.includes("--write-probe");

const s3 = new S3Client({
	region: config.region,
	endpoint: config.endpoint,
	credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
	forcePathStyle: config.forcePathStyle,
	// Some providers reject the SDK's default flexible-checksum trailers — same reason as s3.ts.
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});

const region = config.region;
const bucket = config.bucket;
const host = config.publicBaseUrl;

/**
 * Origins that must be able to reach storage from a browser, and why. A presigned upload
 * is a `PUT`, which is never a CORS-simple request; HLS playback is a `GET` via XHR from
 * hls.js. Checking only PUT would pass a config that fixed uploads and left playback
 * broken, so both are probed.
 */
const BROWSER_ORIGINS = [
	["https://anthers.org", "the site — including /studio, which performs media uploads"],
	["https://www.anthers.org", "www variant"],
	["tauri://localhost", "packaged desktop Studio (raw XHR, so CORS applies)"],
] as const;

/**
 * An origin that must be REFUSED. Without it every line above can pass for the worst
 * possible reason: a bucket answering `*` echoes whatever you send it, so a wide-open
 * bucket and a correctly-configured one produce identical output on the three origins we
 * care about. Same shape as `webhook-check`'s wrong-secret control — a check that only
 * ever asks for the answer it wants cannot tell you the answer means anything.
 *
 * `.invalid` is reserved by RFC 2606, so this can never collide with a real origin.
 */
const CONTROL_ORIGIN = "https://storage-posture-control.invalid";

/**
 * 🚨 **The probe targets are three different hosts, and getting that wrong is how this
 * script spent its life reporting the wrong things.**
 *
 * It used to preflight `publicBaseUrl` (the CDN in front of the PUBLIC bucket) for both
 * columns, against a key under a PRIVATE prefix. Both halves were wrong and each failed in
 * a different direction:
 *
 *   - **PUT never goes to the CDN.** `getPresignedUploadUrl` signs against `config.endpoint`,
 *     so the CDN was answering about a request the app does not send there — and it would
 *     have gone on answering `204` with the S3 endpoint locked down completely. A green
 *     column that cannot go red is worse than no column.
 *   - **The GET was asking the public host for a private key**, so its `403` was the public
 *     bucket correctly refusing an object it does not hold. Read as a CORS finding it is
 *     noise, and noise in an alarm is what teaches people to stop reading it — the same
 *     failure `spec-diff` grew `--secrets-only` to avoid.
 *
 * Where each request really goes, read off the code rather than assumed:
 *
 *   | What            | Host                | Bucket   | Who sends it                              |
 *   | upload          | `config.endpoint`   | private  | `getPresignedUploadUrl` → browser PUT     |
 *   | HLS segment     | `config.endpoint`   | private  | `getUrl({signed:true})` → hls.js XHR      |
 *   | display chrome  | `publicBaseUrl`     | public   | `<img src>` — NOT a CORS request at all   |
 *
 * So the two enforced probes both target the S3 endpoint, and the CDN line is reported
 * without counting: nothing in the app fetches a public object with XHR, and no
 * `crossOrigin` attribute is set anywhere in `apps/web`, so an absent rule there breaks
 * nothing today. If that changes, promote it — but say so, rather than failing a build over
 * a request nobody makes.
 */
const PRIVATE_PROBE_KEY = "creators/1/videos/originals/posture-probe.mp4";
const PUBLIC_PROBE_KEY = "creators/1/covers/posture-probe.jpg";

/** The URL the SDK would address an object at, honouring the addressing style in config. */
function s3ObjectUrl(bucketName: string, key: string): string {
	if (config.forcePathStyle) return `${config.endpoint}/${bucketName}/${key}`;
	const url = new URL(config.endpoint);
	return `${url.protocol}//${bucketName}.${url.host}/${key}`;
}

const PROBES = [
	{
		label: "upload   PUT  → S3 endpoint",
		method: "PUT" as const,
		url: s3ObjectUrl(bucket, PRIVATE_PROBE_KEY),
		enforced: true,
		breaks: "creators cannot upload media from this origin",
	},
	{
		label: "playback GET  → S3 endpoint",
		method: "GET" as const,
		url: s3ObjectUrl(bucket, PRIVATE_PROBE_KEY),
		enforced: true,
		breaks: "HLS segments fail to load from this origin",
	},
	{
		label: "chrome   GET  → CDN",
		method: "GET" as const,
		url: `${host}/${PUBLIC_PROBE_KEY}`,
		enforced: false,
		breaks: "nothing today — images are not CORS requests",
	},
] as const;

/** One preflight. Returns the status and whether the origin was echoed back. */
async function preflight(url: string, origin: string, method: string) {
	const res = await fetch(url, {
		method: "OPTIONS",
		headers: {
			Origin: origin,
			"Access-Control-Request-Method": method,
			// Exactly what the client sends, which depends on the bucket split: with ONE
			// bucket the ACL header is echoed and must be allowed; with TWO it is not sent
			// at all, and demanding it here would test a permission the app never uses —
			// and would fail against a correctly-configured bucket.
			"Access-Control-Request-Headers": config.sendObjectAcl
				? "content-type,x-amz-acl"
				: "content-type",
		},
	});
	// A preflight succeeds with 200 or 204 — R2 answers 204, Spaces answered 200. Requiring
	// 200 alone would report a working bucket as broken.
	const allowed =
		(res.status === 200 || res.status === 204) && !!res.headers.get("access-control-allow-origin");
	return { status: res.status, allowed };
}

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
	console.log(`   ${origin}  — ${label}`);
	for (const probe of PROBES) {
		const { status, allowed } = await preflight(probe.url, origin, probe.method);
		if (probe.enforced) {
			if (!allowed) failures++;
			console.log(
				`      ${allowed ? "ok  " : "FAIL"} ${probe.label.padEnd(28)} ${status}${allowed ? "" : `  → ${probe.breaks}`}`,
			);
		} else {
			// Reported, never counted. See the note on PROBES.
			console.log(
				`      ${allowed ? "note" : "n/a "} ${probe.label.padEnd(28)} ${status}  (${probe.breaks})`,
			);
		}
	}
}

// The control. A bucket answering `*` echoes anything, so without this every line above
// passes identically whether the allowlist is exact or wide open.
console.log(`\n   control — ${CONTROL_ORIGIN} must be REFUSED`);
for (const probe of PROBES.filter((p) => p.enforced)) {
	const { status, allowed } = await preflight(probe.url, CONTROL_ORIGIN, probe.method);
	if (allowed) failures++;
	console.log(
		`      ${allowed ? "FAIL" : "ok  "} ${probe.label.padEnd(28)} ${status}${allowed ? "  → the allowlist admits ANY origin; the checks above prove nothing" : ""}`,
	);
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

	/**
	 * 🚨 Whether the client echoes `x-amz-acl` is NOT a free choice — it is fatal on R2.
	 *
	 * Measured against a live bucket on 2026-08-11: a presigned PUT carrying the header
	 * returns `403 SignatureDoesNotMatch`, because the presigner hoists `x-amz-acl` into the
	 * query string and a client that also sends it as a header changes the canonical request
	 * the signature covers. The identical PUT without it returns 200. So this probe sends
	 * exactly what `getPresignedUploadUrl` sends — `config.sendObjectAcl` — rather than
	 * always echoing, which would report a correctly-configured R2 bucket as broken.
	 *
	 * Note the asymmetry, because it is what makes the S3 compatibility table misleading: a
	 * DIRECT PutObject with `ACL` set succeeds on R2. Only the presigned path breaks.
	 */
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
		if (acl && config.sendObjectAcl) headers["x-amz-acl"] = acl;
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
