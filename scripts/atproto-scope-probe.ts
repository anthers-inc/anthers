// SPDX-License-Identifier: Apache-2.0
/**
 * Ask one question and answer it with evidence: **does bsky.social still honor the narrow
 * permissions Anthers asks for?**
 *
 * Publishing into the repository of a creator whose identity lives elsewhere depends on it:
 * `oauth-repo-writer.ts` writes with a grant over Anthers' own collections and nothing broader.
 * The answer was yes on 2026-09-11 for a raw `repo:` scope and on 2026-09-12 for both permission
 * sets, and this is how that finding is retested — because the ecosystem moves weekly, and
 * learning that it stopped being true from a creator whose listings quietly stopped updating is
 * the worse way to find out.
 *
 * 🚨 **`transition:generic` appears nowhere in this file, and that is the experiment.** The
 * whole point is to find out what a *narrow* grant can do. A probe that fell back to the
 * broad scope on failure would answer a question nobody asked and would leave a live
 * full-access grant on the test account.
 *
 * ⚠️ **An authorization server ACCEPTING a scope proves very little**, which is why this
 * goes all the way to a write. Anthers' own findings already record (2026-08-22) that
 * bsky.social accepts granular scopes at registration *and accepts a nonsense collection
 * too*. Only `com.atproto.repo.createRecord` answering separates "the permission is honored"
 * from "the string was tolerated".
 *
 * 🛑 **And the write commits nothing.** It carries a `swapCommit` naming a commit the repository
 * can never be at, and the reference PDS checks that last: the OAuth permission first, then the
 * record against its Lexicon, and only then whether the repository is at the named commit. So
 * `InvalidSwap` is the answer "the permission is honored and the record is valid", a permission
 * refusal is the answer "it is not", and in neither case does anything land in the repository
 * or go out on the firehose. A real write would broadcast a creation and a deletion to everyone
 * listening, which is exactly the kind of messy write Anthers does not make from a test.
 *
 * **It refuses to run without a terminal**, for two reasons rather than one. OAuth needs a
 * person at a browser, so there is nothing for an unattended run to do; and it sends a write to
 * a real repository on the public network, which is not something a cron job should be able to
 * start even when the write is built to be refused.
 *
 * ⚠️ **If a server ever ignores `swapCommit` and commits the record anyway, the probe deletes it
 * and says so loudly**, because that would be a finding in itself and a record left behind.
 *
 * Usage:
 *   bun run scripts/atproto-scope-probe.ts --handle anthersinc-test.bsky.social
 *   bun run scripts/atproto-scope-probe.ts --handle … --form repo
 *
 * `--form include` (the default) asks via Anthers' published permission set, which is what
 * the running app should use if it works; `--form repo` asks with the raw scope string,
 * which is proven and is the fallback.
 *
 * `--set creator` (the default) asks for `org.anthers.creatorPermissions` and sends a Work
 * listing; `--set user` asks for `org.anthers.userPermissions` and sends a follow of the test
 * account itself. A set naming several collections comes back expanded differently from one naming a single
 * collection, which is the reason each is worth probing on its own.
 */

import { createServer } from "node:http";
import { JoseKey } from "@atproto/jwk-jose";
import {
	AtprotoDohHandleResolver,
	atprotoLoopbackClientMetadata,
	buildAtprotoLoopbackClientId,
	OAuthClient,
} from "@atproto/oauth-client";

/** What each `--set` asks for, and the one record it writes to prove the grant is honored. */
const SETS: Record<string, { permissionSet: string; collection: string }> = {
	creator: { permissionSet: "org.anthers.creatorPermissions", collection: "org.anthers.work" },
	user: { permissionSet: "org.anthers.userPermissions", collection: "org.anthers.follow" },
};

/**
 * The two ways of asking for the same thing, and the reason this probe has a flag.
 *
 * `repo` is the raw form proposal 0011 specifies — `resource[:positional][?params]` — and it
 * is **proven**: granted verbatim and used to write a real record on 2026-09-11.
 *
 * ⭐ `include` names a published permission-set Lexicon instead, which is what puts a title and
 * a sentence on the consent screen rather than `repo:org.anthers.work?action=create&…`. It
 * expands to the same permission, so a success here is not new capability — it is the
 * difference between asking somebody to agree to a string and asking them to agree to a
 * sentence. **Unproven on bsky.social**, exactly as the raw form was before it was tested,
 * which is why it is a probe rather than an assumption.
 *
 * ⚠️ **A failure of `include` is not a failure of the permission.** If the authorization
 * server does not understand the token it may refuse the whole scope string, and the fallback
 * is the raw form — uglier, and already known to work.
 */
function scopeFor(form: string, set: { permissionSet: string; collection: string }): string | null {
	if (form === "include") return `atproto include:${set.permissionSet}`;
	if (form === "repo") return `atproto repo:${set.collection}?action=create&action=delete`;
	return null;
}

/**
 * A commit the repository can never be at: the CID of an empty CBOR map.
 *
 * ⚠️ **Well-formed on purpose, so the refusal is about the swap and not the syntax.** A commit
 * object is never an empty map, so no repository's head can have this CID, and a server that
 * parses it has to carry the write all the way to the commit before refusing it.
 */
export const IMPOSSIBLE_COMMIT = "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua";

/** What a write's answer says about the permission, read the way this probe's findings depend on. */
export type ProbeVerdict =
	/** Refused at the commit, after the permission and the record were both accepted. */
	| "honored"
	/** Refused for the credentials: the permission is not honored. */
	| "not_honored"
	/** Refused for the record's shape, which says nothing about the permission. */
	| "record_invalid"
	/** The server committed it despite the swap, which is a finding and a record to remove. */
	| "committed"
	/** Anything else, which a person has to read. */
	| "unclear";

export function verdictFor(status: number, body: { error?: string } | null): ProbeVerdict {
	if (status >= 200 && status < 300) return "committed";
	if (body?.error === "InvalidSwap") return "honored";
	if (status === 401 || status === 403) return "not_honored";
	if (status === 400 && (body?.error === "InvalidRequest" || body?.error === "InvalidRecord")) {
		return "record_invalid";
	}
	return "unclear";
}

/** Where the authorization server sends the browser back. Must be a literal loopback IP. */
const PORT = Number(process.env.PROBE_PORT ?? 7325);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * A minimally valid `org.anthers.work` record.
 *
 * ⚠️ **Valid on purpose, so a refusal can only be about permission.** `org.anthers.work` is
 * published and resolves from its name, so bsky.social may well resolve and validate it — and
 * a record rejected for its *shape* would look like a scope failure while proving nothing.
 * Every required field is present and the URL points at a page that will not exist, which is
 * fine: the record says where a work can be reached and asserts nothing about what is there.
 */
function probeRecord(collection: string, did: string) {
	// A follow of the test account itself: valid, and never committed.
	if (collection === "org.anthers.follow") return { $type: collection, subject: did };
	return {
		$type: collection,
		kind: "service",
		title: `Scope probe ${new Date().toISOString()}`,
		url: "https://anthers.org/scope-probe",
		releasedAt: new Date().toISOString(),
		description:
			"A record sent by Anthers' scope probe to find out whether a narrow repo: permission is honored. It is sent with a commit swap the repository can never satisfy, so it should never be committed.",
	};
}

/** In-memory stores. The app persists these in Postgres; one run of a probe needs neither. */
function memoryStore() {
	const map = new Map<string, unknown>();
	return {
		set: async (k: string, v: unknown) => void map.set(k, v),
		get: async (k: string) => map.get(k),
		del: async (k: string) => void map.delete(k),
	};
}

function buildClient(scope: string): OAuthClient {
	return new OAuthClient({
		clientMetadata: {
			...atprotoLoopbackClientMetadata(
				buildAtprotoLoopbackClientId({ redirect_uris: [REDIRECT_URI], scope }),
			),
			client_name: "Anthers scope probe",
		},
		responseMode: "query",
		// DNS-over-HTTPS, matching the app: `node:dns` is the transitive reason the Node
		// OAuth client cannot be used under Bun.
		handleResolver: new AtprotoDohHandleResolver({
			dohEndpoint: process.env.ATPROTO_DOH_ENDPOINT ?? "https://cloudflare-dns.com/dns-query",
		}),
		runtimeImplementation: {
			createKey: (algs: string[]) => JoseKey.generate(algs),
			getRandomValues: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
			digest: async (bytes: Uint8Array, alg: { name: string }) =>
				new Uint8Array(
					await crypto.subtle.digest(alg.name.replace("sha", "SHA-"), bytes as BufferSource),
				),
		},
		stateStore: memoryStore() as never,
		sessionStore: memoryStore() as never,
	});
}

/** Serve the one callback this flow needs and hand back the query string it arrived with. */
function awaitCallback(): Promise<URLSearchParams> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
			if (url.pathname !== "/callback") {
				res.writeHead(404).end("not the callback");
				return;
			}
			res
				.writeHead(200, { "content-type": "text/plain" })
				.end("Authorized. You can close this tab and go back to the terminal.");
			server.close();
			resolve(url.searchParams);
		});
		server.on("error", reject);
		server.listen(PORT, "127.0.0.1");
	});
}

async function main() {
	// 🚨 A person, at a browser. Not a default — an unattended run has nothing it could do
	// with the authorize step, and this writes to the public network.
	if (!process.stdin.isTTY) {
		console.error("atproto-scope-probe: refusing to run without a terminal.");
		process.exit(1);
	}
	if (process.env.CI) {
		console.error("atproto-scope-probe: refusing to run under CI.");
		process.exit(1);
	}

	const handle = arg("handle");
	if (!handle) {
		console.error("atproto-scope-probe: --handle <handle> is required.");
		console.error("  e.g. --handle anthersinc-test.bsky.social");
		process.exit(1);
	}

	const form = arg("form") ?? "include";
	const set = SETS[arg("set") ?? "creator"];
	if (!set) {
		console.error(`atproto-scope-probe: --set must be one of ${Object.keys(SETS).join(", ")}.`);
		process.exit(1);
	}
	const scope = scopeFor(form, set);
	if (!scope) {
		console.error("atproto-scope-probe: --form must be one of include, repo.");
		process.exit(1);
	}
	const COLLECTION = set.collection;
	const PERMISSION_SET = set.permissionSet;

	console.log(`\nProbing whether a narrow permission is honored, as ${handle}.`);
	console.log(`  form:            ${form}`);
	console.log(`  scope requested: ${scope}`);
	console.log(`  collection:      ${COLLECTION}\n`);
	if (form === "include") {
		// ⭐ Worth saying at the top, because the interesting part of this run is what the
		// consent screen looks like — and only the person at the browser can see that.
		console.log("  ⭐ Read the consent screen before you approve it. The question this run");
		console.log("     answers is whether it shows Anthers' own sentence rather than a raw");
		console.log(`     scope string. The set is ${PERMISSION_SET}.\n`);
	}

	const client = buildClient(scope);

	// ── 1. Authorize ────────────────────────────────────────────────────────
	//
	// The first of the three things this probe can learn. A refusal HERE means the scope
	// string itself was rejected, which is a different finding from a refusal at the write.
	let authUrl: URL;
	try {
		authUrl = await client.authorize(handle, { scope });
	} catch (err) {
		console.error("\nRESULT: the authorization request was refused outright.");
		console.error("  The scope string was not accepted by the authorization server.");
		console.error(`  ${err instanceof Error ? err.message : String(err)}`);
		if (form === "include") {
			console.error("\n  ⚠️ This is the `include:` form. A refusal here means the permission");
			console.error("     SET is not understood — not that the permission is unavailable.");
			console.error("     Re-run with `--form repo` to confirm the raw form still works.");
		}
		process.exit(2);
	}

	console.log("Open this, authorize as the test account, and come back:\n");
	console.log(`  ${authUrl.toString()}\n`);

	const params = await awaitCallback();
	if (params.get("error")) {
		console.error(`\nRESULT: authorization was refused — ${params.get("error")}`);
		console.error(`  ${params.get("error_description") ?? ""}`);
		process.exit(2);
	}

	const { session } = await client.callback(params);
	const did = session.did;

	// ⭐ **What was actually GRANTED, which need not be what was asked for.** An
	// authorization server may narrow a request silently, and a probe that assumed it got
	// what it asked for would attribute the wrong cause to whatever happens next.
	const info = await session.getTokenInfo().catch(() => null);
	console.log(`Authorized as ${did}`);
	console.log(`  scope granted: ${info?.scope ?? "(the session did not report one)"}\n`);

	// ── 2. Write, refused at the commit ─────────────────────────────────────
	let rkey: string | null = null;
	try {
		const res = await session.fetchHandler("/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				repo: did,
				collection: COLLECTION,
				record: probeRecord(COLLECTION, did),
				swapCommit: IMPOSSIBLE_COMMIT,
			}),
		});
		const body = (await res.json().catch(() => null)) as {
			uri?: string;
			error?: string;
			message?: string;
		} | null;

		switch (verdictFor(res.status, body)) {
			case "honored":
				console.log("RESULT: ✅ THE PERMISSION IS HONORED.");
				console.log(`  The server accepted the permission and the record, and refused only the`);
				console.log(`  commit swap (${body?.message ?? "InvalidSwap"}). Nothing was written.`);
				console.log("\n  A narrow repo: permission is honored on bsky.social today.");
				break;
			case "not_honored":
				console.log(`RESULT: ❌ the permission is not honored — HTTP ${res.status}.`);
				console.log(`  error:   ${body?.error ?? "(none)"}`);
				console.log(`  message: ${body?.message ?? "(none)"}`);
				break;
			case "record_invalid":
				console.log("RESULT: ⚠️ the record was refused for its shape, which says nothing about");
				console.log("  the permission. This probe's record is wrong; fix it and run again.");
				console.log(`  message: ${body?.message ?? "(none)"}`);
				break;
			case "committed":
				rkey = body?.uri?.split("/").pop() ?? null;
				console.log("RESULT: 🚨 THE SERVER COMMITTED THE RECORD despite the impossible swap.");
				console.log(`  ${body?.uri ?? "(no URI returned)"}`);
				console.log("  That is a finding in itself: this probe's no-write proof does not hold");
				console.log("  there. The permission IS honored, and the record is being removed now.");
				break;
			default:
				console.log(`RESULT: ? an answer this probe cannot read — HTTP ${res.status}.`);
				console.log(`  error:   ${body?.error ?? "(none)"}`);
				console.log(`  message: ${body?.message ?? "(none)"}`);
				console.log("  A loopback client may be restricted in ways a real one is not.");
		}
	} finally {
		// ── 3. Clean up ─────────────────────────────────────────────────────
		if (rkey) {
			const del = await session
				.fetchHandler("/xrpc/com.atproto.repo.deleteRecord", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ repo: did, collection: COLLECTION, rkey }),
				})
				.catch(() => null);
			console.log(
				del?.ok
					? "\nRemoved the record the server should never have committed."
					: "\n⚠️ COULD NOT DELETE the committed probe record — remove it by hand.",
			);
		}
		// The grant itself is revoked too. Leaving a live authorization on a test account
		// for a probe that has finished is the same untidiness as leaving a record.
		await client.revoke(did).catch(() => {});
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
