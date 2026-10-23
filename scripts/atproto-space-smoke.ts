// SPDX-License-Identifier: Apache-2.0
/**
 * Drive the space client against a real PDS and prove the user-space round trip.
 *
 * The unit tests hold the transport to the Lexicon shapes; this holds it to a
 * server. Point it at a running spaces-capable PDS, such as the lab's network,
 * and it creates an account, a space, a record, reads the record back, and checks
 * the commit and the oplog. It is the Phase 0 gate in executable form.
 *
 * The account is disposable. The script prints no token and writes nothing to a
 * real network unless the operator points it at one.
 *
 * Usage:
 *   PDS_URL=http://127.0.0.1:2683 bun run scripts/atproto-space-smoke.ts
 *   PDS_URL=… SPACE_SMOKE_HANDLE=… SPACE_SMOKE_PASSWORD=… bun run scripts/atproto-space-smoke.ts
 */

import { isDeepStrictEqual } from "node:util";
import { SpaceClient } from "../apps/api/src/services/atproto-space.js";

const PDS_URL = process.env.PDS_URL ?? "http://127.0.0.1:2683";
const INVITE = process.env.SPACE_SMOKE_INVITE;
const HANDLE = process.env.SPACE_SMOKE_HANDLE;
const PASSWORD = process.env.SPACE_SMOKE_PASSWORD;
const EMAIL =
	process.env.SPACE_SMOKE_EMAIL ?? `spaces-smoke+${Date.now().toString(36)}@example.com`;

interface Check {
	name: string;
	ok: boolean;
	detail?: unknown;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
	checks.push({ name, ok, detail });
	if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

async function xrpc(
	method: string,
	body: Record<string, unknown>,
): Promise<{ did: string; accessJwt: string }> {
	const response = await fetch(new URL(`/xrpc/${method}`, PDS_URL), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const data = text ? JSON.parse(text) : {};
	if (!response.ok) {
		throw new Error(
			`${method} failed: ${response.status} ${data.error ?? ""} ${data.message ?? text}`,
		);
	}
	return data as { did: string; accessJwt: string };
}

async function session(): Promise<{ did: string; token: string; handle: string }> {
	if (HANDLE && PASSWORD) {
		const data = await xrpc("com.atproto.server.createSession", {
			identifier: HANDLE,
			password: PASSWORD,
		});
		return { did: data.did, token: data.accessJwt, handle: HANDLE };
	}

	const handle = `smoke-${Date.now().toString(36)}.spaces.test`;
	const password = `smoke-${crypto.randomUUID()}`;
	const data = await xrpc("com.atproto.server.createAccount", {
		handle,
		email: EMAIL,
		password,
		...(INVITE ? { inviteCode: INVITE } : {}),
	});
	check("account created", Boolean(data.did && data.accessJwt), { handle, did: data.did });
	return { did: data.did, token: data.accessJwt, handle };
}

async function main(): Promise<Record<string, unknown>> {
	const { did, token, handle } = await session();
	const client = new SpaceClient({ baseUrl: PDS_URL, token });

	const spaceType = "org.anthers.userSpace";
	const spaceKey = "self";
	const created = await client.createSpace({
		spaceType,
		skey: spaceKey,
		readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
		writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
		appAccess: { $type: "com.atproto.simplespace.defs#open" },
	});
	const space = created.uri;
	check(
		"space created under the account",
		space === `at://${did}/space/${spaceType}/${spaceKey}`,
		space,
	);

	const collection = "com.example.smoke";
	const rkey = "one";
	const record = {
		$type: collection,
		work: "at://did:plc:example/org.anthers.work/nightjar",
		createdAt: new Date().toISOString(),
	};

	const written = await client.putRecord({
		space,
		repo: did,
		collection,
		rkey,
		record,
		validate: false,
	});
	check("record written at a known key", Boolean(written.uri && written.cid), written);

	const read = await client.getRecord({ space, repo: did, collection, rkey });
	check("read-back URI matches", read.uri === written.uri, read);
	check("read-back CID matches", read.cid === written.cid, read);
	check("read-back value matches", isDeepStrictEqual(read.value, record), read.value);

	const latest = await client.getLatestCommit({ space, repo: did });
	check("commit names the repo", latest.commit.repo === did, latest.commit);
	check("commit names the space", latest.commit.space === space, latest.commit);
	check("commit has a revision", typeof latest.commit.rev === "string", latest.commit);

	const ops = await client.listRepoOps({ space, repo: did });
	const op = ops.ops.find((entry) => entry.collection === collection && entry.rkey === rkey);
	check("oplog contains the record", Boolean(op), ops.ops);
	check("oplog CID matches", op?.cid === written.cid, op);

	const spaces = await client.listSpaces({ did });
	check(
		"owner's space is listed",
		spaces.spaces.some((entry) => entry.uri === space),
		spaces.spaces,
	);

	const members = await client.listMembers(space);
	check("the member list reads", Array.isArray(members.members), members.members);

	const description = await client.getSpace(space);
	check("the space's policies read back", description.uri === space, description);

	return {
		ok: true,
		pds: PDS_URL,
		handle,
		did,
		space,
		uri: written.uri,
		cid: written.cid,
		rev: latest.commit.rev,
		checks,
	};
}

try {
	console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{
				ok: false,
				pds: PDS_URL,
				error: error instanceof Error ? error.message : String(error),
				checks,
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
}
