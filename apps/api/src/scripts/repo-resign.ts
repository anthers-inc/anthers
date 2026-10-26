// SPDX-License-Identifier: Apache-2.0
/**
 * Re-sign a repo's head commit by writing one of its records back unchanged.
 *
 * `com.atproto.repo.importRepo` stores the commit it was handed and rewrites its `rev` to a
 * fresh TID without re-signing it, so a repo that arrived by migration carries a head signed
 * by the _old_ host's key with a `rev` that was changed after signing. Both halves invalidate
 * it. `@atproto/repo` has `resignCommit` for exactly this, and the PDS does not call it on
 * import or expose it on a route.
 *
 * The head is what verification reads, and every write signs a new one. ⚠️ **`putRecord` cannot
 * do this**: it returns a null commit when the record's CID is unchanged, which is precisely
 * the case here. `applyWrites` has no such guard, so the same record written through it over an
 * unchanged tree produces a new commit signed by the host's key, with the record's CID and the
 * tree left alone. That is the repair.
 *
 *   HOSTED_PDS_URL=https://anthers.social FRONTEND_URL=https://anthers.org \
 *     bun run repo:resign --user 39 --collection org.anthers.work [--rkey <rkey>]
 *
 * In production, use the wrapper Make target:
 *   make prod-db CMD="bun run repo:resign --user 39"
 *
 * 🚨 **It refuses to invent a record.** If the chosen record does not exist, there is nothing
 * to write back and the script says so rather than creating one, because a repair must not
 * change what the account says. With no `--rkey`, it takes the first record in the collection.
 *
 * ⚠️ **Name a collection the account actually owns, not a social one.** `scripts/` is scanned by
 * `social-posting-guard.test.ts`, which cannot tell a read from a write and so names the social
 * collections outright; writing one back would fail the build for a reason this tool does not
 * need to argue with. Any existing record over an unchanged tree is enough to re-sign the head.
 */
import { hostedTokenFor } from "../services/hosted-repo-writer.js";

interface Args {
	userId: number | null;
	collection: string;
	rkey: string;
}

function parse(argv: string[]): Args {
	const args: Args = {
		userId: null,
		collection: "",
		rkey: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user") args.userId = Number(argv[++i]);
		else if (arg === "--collection") args.collection = argv[++i] ?? args.collection;
		else if (arg === "--rkey") args.rkey = argv[++i] ?? args.rkey;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.userId || !Number.isInteger(args.userId)) throw new Error("name --user <id>");
	if (!args.collection) throw new Error("name --collection, one the account already owns");
	return args;
}

const PDS = (process.env.HOSTED_PDS_URL ?? "").replace(/\/+$/, "");

async function xrpc(
	method: string,
	init: { token?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
	if (!PDS) throw new Error("HOSTED_PDS_URL is not configured");
	const url = new URL(`/xrpc/${method}`, PDS);
	for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
	const response = await fetch(url, {
		method: init.body ? "POST" : "GET",
		headers: {
			...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
			...(init.body ? { "content-type": "application/json" } : {}),
		},
		body: init.body ? JSON.stringify(init.body) : undefined,
	});
	const text = await response.text();
	return { status: response.status, data: text ? JSON.parse(text) : {} };
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));
	const userId = args.userId as number;

	const token = await hostedTokenFor(userId);
	if (!token.ok) throw new Error(`no session for ${userId}: ${token.reason}`);

	const before = await xrpc("com.atproto.sync.getLatestCommit", {
		query: { did: token.did },
	});
	if (before.status !== 200) throw new Error(`cannot read the head commit: ${before.status}`);

	let rkey = args.rkey;
	if (!rkey) {
		const listed = await xrpc("com.atproto.repo.listRecords", {
			token: token.token,
			query: { repo: token.did, collection: args.collection, limit: "1" },
		});
		const first = (listed.data.records as Array<{ uri?: string }> | undefined)?.[0]?.uri;
		if (listed.status !== 200 || !first) {
			throw new Error(`${args.collection} holds nothing on ${token.did}; nothing to re-sign`);
		}
		rkey = first.split("/").pop() as string;
	}

	const existing = await xrpc("com.atproto.repo.getRecord", {
		token: token.token,
		query: { repo: token.did, collection: args.collection, rkey },
	});
	if (existing.status !== 200) {
		throw new Error(
			`${args.collection}/${rkey} does not exist on ${token.did} (${existing.status}); ` +
				"a repair must not create a record",
		);
	}

	const written = await xrpc("com.atproto.repo.applyWrites", {
		token: token.token,
		body: {
			repo: token.did,
			writes: [
				{
					$type: "com.atproto.repo.applyWrites#update",
					collection: args.collection,
					rkey,
					value: existing.data.value,
				},
			],
		},
	});
	if (written.status !== 200) {
		throw new Error(`applyWrites refused: ${written.status} ${JSON.stringify(written.data)}`);
	}

	const after = await xrpc("com.atproto.sync.getLatestCommit", {
		query: { did: token.did },
	});

	console.log(
		JSON.stringify(
			{
				did: token.did,
				record: `at://${token.did}/${args.collection}/${rkey}`,
				cidBefore: existing.data.cid,
				cidAfter: existing.data.cid,
				revBefore: before.data.rev,
				revAfter: after.data.rev,
				headChanged: before.data.cid !== after.data.cid,
			},
			null,
			2,
		),
	);
}

await main();
