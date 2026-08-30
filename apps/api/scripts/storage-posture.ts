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
 * `--cors-only` runs the preflight matrix alone and needs **no credentials at all**, which
 * is what lets a scheduled workflow watch the setting that broke.
 *
 *   bun run apps/api/scripts/storage-posture.ts               # inspect config + CORS
 *   bun run apps/api/scripts/storage-posture.ts --write-probe # + real PUT/read/delete
 *   bun run apps/api/scripts/storage-posture.ts --cors-only   # preflights only, no secrets
 *
 * Exit codes: 0 clean, 1 a real finding, 2 the live state could not be determined.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorageConfig } from "../src/services/storage/config.js";

const writeProbe = process.argv.includes("--write-probe");

/**
 * ⭐ **`--cors-only` needs NO CREDENTIALS, and that is what makes it automatable.**
 *
 * A CORS preflight is an unauthenticated `OPTIONS` — the bucket answers it before any
 * signature is considered — so the check that would have caught the `www` outage can run
 * anywhere, including a scheduled workflow with no vault access. Everything else in this
 * file needs the runtime key, which is why the rest is a manual tool.
 *
 * The non-secret `STORAGE_*` values come from the committed spec when the environment does
 * not supply them. 🚨 **Deliberately NOT through `loadSharedSpecEnv`**: that list feeds the
 * API's own boot path, and its docblock explains at length why `STORAGE_*` must never join
 * it — a machine with no `.env` would take `STORAGE_BACKEND=s3` from the spec and boot
 * straight into a credential error. Reading them here, in a script that only ever sends an
 * OPTIONS request, borrows none of that hazard.
 */
const corsOnly = process.argv.includes("--cors-only");

function specValue(key: string): string {
	if ((process.env[key] ?? "") !== "") return process.env[key] as string;
	let dir = import.meta.dir;
	for (let depth = 0; depth < 8; depth++) {
		const candidate = join(dir, ".do", "app.yaml");
		if (existsSync(candidate)) {
			type Entry = { key?: string; value?: string; type?: string };
			const spec = Bun.YAML.parse(readFileSync(candidate, "utf8")) as {
				envs?: Entry[];
				services?: { envs?: Entry[] }[];
				workers?: { envs?: Entry[] }[];
			};
			const all = [
				...(spec.envs ?? []),
				...(spec.services ?? []).flatMap((s) => s.envs ?? []),
				...(spec.workers ?? []).flatMap((w) => w.envs ?? []),
			];
			const hit = all.find((e) => e.key === key && e.type !== "SECRET");
			return hit?.value ?? "";
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "";
}

/**
 * Configuration comes from `resolveStorageConfig()` — the same resolver the application
 * uses — rather than being read out of the environment a second time here.
 *
 * It used to read `SPACES_*` directly and compose a DigitalOcean host, which meant this
 * probe could disagree with the app about where storage even *is*. That is a bad property
 * in the one tool whose job is to tell you what production actually looks like, and it
 * became an outright bug when the app moved to R2 while this file still pointed at Spaces.
 *
 * Under `--cors-only` the same shape is assembled from non-secret values alone, because
 * `resolveStorageConfig` requires the key and secret and would throw before the one check
 * that does not need them could run.
 */
const config = corsOnly
	? {
			region: specValue("STORAGE_REGION") || "auto",
			bucket: specValue("STORAGE_BUCKET"),
			publicBucket: specValue("STORAGE_PUBLIC_BUCKET"),
			endpoint: specValue("STORAGE_ENDPOINT"),
			publicBaseUrl: specValue("STORAGE_PUBLIC_BASE_URL").replace(/\/+$/, ""),
			forcePathStyle: specValue("STORAGE_FORCE_PATH_STYLE") === "true",
			// The bucket carries access on a two-bucket provider, so nothing echoes an ACL
			// header — the same rule `resolveStorageConfig` derives.
			sendObjectAcl: false,
			accessKeyId: "",
			secretAccessKey: "",
		}
	: resolveStorageConfig();

if (corsOnly && (!config.endpoint || !config.bucket)) {
	console.error(
		"storage-posture --cors-only: no STORAGE_ENDPOINT/STORAGE_BUCKET in the environment or .do/app.yaml",
	);
	process.exit(2);
}

/**
 * 🚨 **The AWS SDK is imported DYNAMICALLY, and `--cors-only` must never reach it.**
 *
 * `deploy-watch.yml` runs this with **no `bun install`** — a property that workflow states
 * outright and relies on, because `deploy-status` and `spec-diff` use only Bun built-ins. A
 * static `@aws-sdk/client-s3` import would fail to resolve there and exit non-zero, and
 * since a red run IS that workflow's alert channel, the watchdog would be indistinguishable
 * from the thing it watches for. That exact failure already cost this workflow its first
 * day alive (no `setup-bun`, every run exit 127), so it is worth not repeating in a
 * different costume.
 */
const sdk = corsOnly ? null : await import("@aws-sdk/client-s3");

const s3 =
	corsOnly || !sdk
		? null
		: new sdk.S3Client({
				region: config.region,
				endpoint: config.endpoint,
				credentials: {
					accessKeyId: config.accessKeyId,
					secretAccessKey: config.secretAccessKey,
				},
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

/** The URL the SDK would address an object at, honoring the addressing style in config. */
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

/**
 * One preflight. Returns the status and whether the origin was echoed back.
 *
 * ⚠️ **`unreachable` is a third answer, not a failure**, and the distinction is the same one
 * `deploy-status` draws between exit 1 and exit 2: a network error from wherever this runs
 * is evidence about the network, not about our configuration. Counting it as a finding is
 * how a scheduled check starts crying wolf, and a check people have learned to ignore is
 * worth less than no check.
 */
async function preflight(url: string, origin: string, method: string) {
	let res: Response;
	try {
		res = await fetch(url, {
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
	} catch (err) {
		return { status: 0, allowed: false, unreachable: true, why: (err as Error).message };
	}
	// A 5xx is the bucket's host having a bad day, not an answer about the allowlist.
	if (res.status >= 500) return { status: res.status, allowed: false, unreachable: true, why: "" };
	// A preflight succeeds with 200 or 204 — R2 answers 204, Spaces answered 200. Requiring
	// 200 alone would report a working bucket as broken.
	const allowed =
		(res.status === 200 || res.status === 204) && !!res.headers.get("access-control-allow-origin");
	return { status: res.status, allowed, unreachable: false, why: "" };
}

let failures = 0;

console.log(`bucket=${bucket} region=${region}\n`);

// ── Bucket-level configuration ───────────────────────────────────────────────
const corsOrigins: string[] = [];
if (s3 && sdk) {
	try {
		const acl = await s3.send(new sdk.GetBucketAclCommand({ Bucket: bucket }));
		const publicGrants = (acl.Grants ?? []).filter((g) => g.Grantee?.Type === "Group");
		console.log(`bucket ACL: ${publicGrants.length === 0 ? "owner only" : "HAS GROUP GRANTS"}`);
		for (const g of publicGrants) console.log(`   !! ${g.Grantee?.URI} = ${g.Permission}`);
		if (publicGrants.length > 0) failures++;
	} catch (err) {
		console.log(`bucket ACL: unreadable — ${(err as Error).message}`);
	}

	try {
		const pol = await s3.send(new sdk.GetBucketPolicyCommand({ Bucket: bucket }));
		console.log(`bucket policy: present\n${pol.Policy}`);
	} catch {
		// Note: DO Spaces does NOT implement GetBucketPolicyStatus, so "is this bucket
		// public?" cannot be asked directly — the write probe below is how you find out.
		console.log("bucket policy: none (no prefix-level ACL enforcement)");
	}

	// ── CORS ─────────────────────────────────────────────────────────────────────
	console.log("\n── CORS rules");
	try {
		const cors = await s3.send(new sdk.GetBucketCorsCommand({ Bucket: bucket }));
		for (const r of cors.CORSRules ?? []) {
			corsOrigins.push(...(r.AllowedOrigins ?? []));
			console.log(
				`   ${(r.AllowedOrigins ?? []).join(", ")} — methods=${(r.AllowedMethods ?? []).join("/")} headers=${(r.AllowedHeaders ?? []).join(",")}`,
			);
		}
	} catch (err) {
		console.log(`   unreadable — ${(err as Error).message}`);
	}
} else {
	// --cors-only. These three reads all need the runtime key, and on R2 they answer
	// AccessDenied even with it — the preflight below is the evidence either way.
	console.log("(--cors-only: skipping the credentialed reads)");
}

let unreachable = 0;

console.log("\n── Preflight (what a browser actually gets)");
for (const [origin, label] of BROWSER_ORIGINS) {
	console.log(`   ${origin}  — ${label}`);
	for (const probe of PROBES) {
		const r = await preflight(probe.url, origin, probe.method);
		if (r.unreachable) {
			unreachable++;
			console.log(`      ??   ${probe.label.padEnd(28)} unreachable ${r.why || r.status}`);
		} else if (probe.enforced) {
			if (!r.allowed) failures++;
			console.log(
				`      ${r.allowed ? "ok  " : "FAIL"} ${probe.label.padEnd(28)} ${r.status}${r.allowed ? "" : `  → ${probe.breaks}`}`,
			);
		} else {
			// Reported, never counted. See the note on PROBES.
			console.log(
				`      ${r.allowed ? "note" : "n/a "} ${probe.label.padEnd(28)} ${r.status}  (${probe.breaks})`,
			);
		}
	}
}

// The control. A bucket answering `*` echoes anything, so without this every line above
// passes identically whether the allowlist is exact or wide open.
console.log(`\n   control — ${CONTROL_ORIGIN} must be REFUSED`);
for (const probe of PROBES.filter((p) => p.enforced)) {
	const r = await preflight(probe.url, CONTROL_ORIGIN, probe.method);
	if (r.unreachable) {
		unreachable++;
		console.log(`      ??   ${probe.label.padEnd(28)} unreachable ${r.why || r.status}`);
		continue;
	}
	if (r.allowed) failures++;
	console.log(
		`      ${r.allowed ? "FAIL" : "ok  "} ${probe.label.padEnd(28)} ${r.status}${r.allowed ? "  → the allowlist admits ANY origin; the checks above prove nothing" : ""}`,
	);
}

// A wildcard would make every check above pass for the wrong reason.
if (corsOrigins.includes("*")) {
	console.log("   !! CORS allows '*' — every origin passes, including ones we don't run");
	failures++;
}

// ── What a PUT actually produces ─────────────────────────────────────────────
if (writeProbe && s3 && sdk) {
	const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
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
		["no ACL (the old presign behavior)", undefined],
		["explicit private", "private"],
	] as const) {
		const key = `${base}.${acl ?? "none"}.txt`;
		const url = await getSignedUrl(
			s3,
			new sdk.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "text/plain", ACL: acl }),
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
		const objAcl = await s3.send(new sdk.GetObjectAclCommand({ Bucket: bucket, Key: key }));
		const worldReadable = (objAcl.Grants ?? []).some((g) => g.Grantee?.Type === "Group");
		const anon = await fetch(`${host}/${key}`);
		if (worldReadable || anon.status === 200) failures++;
		console.log(
			`   ${worldReadable || anon.status === 200 ? "FAIL" : "ok  "} ${label.padEnd(34)} anonymous GET ${anon.status} (200 = world readable)`,
		);
		await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
	}

	// The uncomfortable one: a presigned URL signs only `host`, so the CLIENT picks the
	// ACL and Spaces honors it over the one the server signed. Only a bucket policy can
	// enforce the posture — this line is here so that stays visible rather than assumed.
	const key = `${base}.client-override.txt`;
	const url = await getSignedUrl(
		s3,
		new sdk.PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: "text/plain",
			ACL: "private",
		}),
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
		await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
	}
}

/**
 * Three exit codes, and the 2 is the load-bearing one: **0** nothing wrong, **1** a real
 * finding, **2** the live state could not be determined. Same split `deploy-status` draws,
 * for the same reason — a caller that cannot tell "your bucket is misconfigured" from "the
 * network was down" will eventually treat both as noise.
 */
if (unreachable > 0) {
	console.log(`\n${unreachable} probe(s) unreachable — the live state could not be determined.`);
	process.exit(2);
}
console.log(`\n${failures === 0 ? "No problems found." : `${failures} problem(s) found.`}`);
process.exit(failures === 0 ? 0 : 1);
