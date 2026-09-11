// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ask one question and answer it with evidence: **will bsky.social honor a `repo:`-scoped
 * permission today?**
 *
 * If it will, Anthers can publish a creator's Work listing into the repository they already
 * have — the thing that currently requires `transition:generic`, which is App-Password
 * equivalent access to somebody's whole account and is the reason record publishing is
 * limited to identities Anthers hosts. If it will not, the wait is confirmed rather than
 * assumed, which is worth almost as much.
 *
 * 🚨 **`transition:generic` appears nowhere in this file, and that is the experiment.** The
 * whole point is to find out what a *narrow* grant can do. A probe that fell back to the
 * broad scope on failure would answer a question nobody asked and would leave a live
 * full-access grant on the test account.
 *
 * ⚠️ **An authorization server ACCEPTING a scope proves very little**, which is why this
 * goes all the way to a write. Anthers' own findings already record (2026-08-22) that
 * bsky.social accepts granular scopes at registration *and accepts a nonsense collection
 * too*. Only `com.atproto.repo.createRecord` returning success or a refusal separates "the
 * permission is honored" from "the string was tolerated".
 *
 * **It refuses to run without a terminal**, for two reasons rather than one. OAuth needs a
 * person at a browser, so there is nothing for an unattended run to do; and this writes a
 * real record into a real repository on the public network, which is not something a cron
 * job should be able to start.
 *
 * **The record is deleted in a `finally`**, on success and on failure. A listing that
 * outlives the thing it advertises is the failure the whole listing design is shaped around,
 * and a probe that leaves one behind has created exactly that.
 *
 * Usage:
 *   bun run scripts/atproto-scope-probe.ts --handle anthersinc-test.bsky.social
 *   bun run scripts/atproto-scope-probe.ts --handle … --form repo
 *
 * `--form include` (the default) asks via Anthers' published permission set, which is what
 * the running app should use if it works; `--form repo` asks with the raw scope string,
 * which is proven and is the fallback.
 */

import { createServer } from "node:http";
import { JoseKey } from "@atproto/jwk-jose";
import {
	AtprotoDohHandleResolver,
	atprotoLoopbackClientMetadata,
	buildAtprotoLoopbackClientId,
	OAuthClient,
} from "@atproto/oauth-client";

/** The collection this probe asks to write, and the one Anthers actually cares about. */
const COLLECTION = "org.anthers.work";

/** Anthers' published permission set, which names that collection in readable language. */
const PERMISSION_SET = "org.anthers.catalogPermissions";

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
const SCOPES: Record<string, string> = {
	include: `atproto include:${PERMISSION_SET}`,
	repo: `atproto repo:${COLLECTION}?action=create&action=delete`,
};

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
function probeRecord() {
	return {
		$type: COLLECTION,
		kind: "service",
		title: `Scope probe ${new Date().toISOString()}`,
		url: "https://anthers.org/scope-probe",
		releasedAt: new Date().toISOString(),
		description:
			"A throwaway record written by Anthers' scope probe to find out whether a narrow repo: permission is honored. It should be deleted seconds after it was made.",
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
	const scope = SCOPES[form];
	if (!scope) {
		console.error(`atproto-scope-probe: --form must be one of ${Object.keys(SCOPES).join(", ")}.`);
		process.exit(1);
	}

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

	// ── 2. Write ────────────────────────────────────────────────────────────
	let rkey: string | null = null;
	try {
		const res = await session.fetchHandler("/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repo: did, collection: COLLECTION, record: probeRecord() }),
		});
		const body = (await res.json().catch(() => null)) as {
			uri?: string;
			error?: string;
			message?: string;
		} | null;

		if (res.ok && body?.uri) {
			rkey = body.uri.split("/").pop() ?? null;
			console.log("RESULT: ✅ THE WRITE SUCCEEDED.");
			console.log(`  ${body.uri}`);
			console.log("\n  A narrow repo: permission is honored on bsky.social today.");
			console.log("  Anthers can publish listings into a creator's own repository without");
			console.log("  asking for access to the rest of their account.");
		} else {
			console.log(`RESULT: ❌ the write was refused — HTTP ${res.status}.`);
			console.log(`  error:   ${body?.error ?? "(none)"}`);
			console.log(`  message: ${body?.message ?? "(none)"}`);
			console.log("\n  ⚠️ Read the error before concluding the permission is unavailable:");
			console.log("     an auth/scope error means it is not honored yet;");
			console.log("     a lexicon or validation error means this probe's record is wrong;");
			console.log("     and a loopback client may be restricted in ways a real one is not.");
		}
	} finally {
		// ── 3. Clean up, always ─────────────────────────────────────────────
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
					? "\nCleaned up: the probe record was deleted."
					: "\n⚠️ COULD NOT DELETE the probe record — remove it by hand.",
			);
		}
		// The grant itself is revoked too. Leaving a live authorization on a test account
		// for a probe that has finished is the same untidiness as leaving the record.
		await client.revoke(did).catch(() => {});
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
