// SPDX-License-Identifier: Apache-2.0
/**
 * Record an identity that already lives on the node as one Anthers hosts.
 *
 * Every space write and every verified repo write resolves a session through
 * `hosted_accounts`: a row with the DID and a sealed session. Signup creates that row as part
 * of establishing the identity, so an account made here has one by construction. An account
 * that arrived another way does not — most often because it was moved onto the node with a
 * public tool (`goat account migrate`), which knows the protocol and nothing about Anthers'
 * bookkeeping. Without the row the account is genuinely hosted and the app still answers
 * `not_hosted` for it.
 *
 *   HOSTED_PDS_URL=https://anthers.social HOSTED_RECORD_PASSWORD=… \
 *     bun run hosted:record --user 39 [--did did:plc:…] [--handle …]
 *
 * ⚠️ **`HOSTED_PDS_URL` and `FRONTEND_URL` are spec values rather than vault secrets**, so a
 * local run has to name them; the deployed components already carry both. The second one is
 * not decoration: `lib/atproto-network.ts` refuses a real host from anything that is not a
 * public deployment, and an https `FRONTEND_URL` is what that detection reads.
 *
 * In production, use the wrapper Make target, which injects `DATABASE_URL` without the
 * connection string appearing on a command line:
 *   make prod-db CMD="bun run hosted:record --user 39"
 *
 * 🚨 **The password is checked before its session is sealed, because a sealed session nobody can
 * renew is the failure nobody can undo from outside.** The check is a real `createSession`
 * against the node with the DID and that password: only the PDS that actually holds the account
 * will accept it, so one call proves both that the account is here and that the credential is
 * right. The password arrives in the environment, never as an argument, and is never printed or
 * stored — the session it returns is what the row keeps.
 */
import { db } from "@anthers/db";
import { hostedAccounts, users } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { recordHostedIdentity } from "../services/hosted-accounts.js";
import { hostedPdsUrl } from "../services/hosted-node.js";

interface Args {
	userId: number | null;
	did: string | null;
	handle: string | null;
}

function parse(argv: string[]): Args {
	const args: Args = { userId: null, did: null, handle: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user") args.userId = Number(argv[++i]);
		else if (arg === "--did") args.did = argv[++i] ?? null;
		else if (arg === "--handle") args.handle = argv[++i] ?? null;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.userId || !Number.isInteger(args.userId)) throw new Error("name --user <id>");
	return args;
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));
	const userId = args.userId as number;

	const password = process.env.HOSTED_RECORD_PASSWORD?.trim();
	if (!password) throw new Error("set HOSTED_RECORD_PASSWORD in the environment");

	const nodeUrl = hostedPdsUrl();
	if (!nodeUrl) throw new Error("HOSTED_PDS_URL is not configured, so this is not a node host");

	const [user] = await db
		.select({
			did: users.atprotoDid,
			handle: users.atprotoHandle,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) throw new Error(`no user ${userId}`);

	const did = args.did ?? user.did;
	const handle = args.handle ?? user.handle;
	if (!did) throw new Error(`user ${userId} has no DID; pass --did`);
	if (!handle) throw new Error(`user ${userId} has no handle; pass --handle`);

	const [existing] = await db
		.select({ did: hostedAccounts.did })
		.from(hostedAccounts)
		.where(and(eq(hostedAccounts.userId, userId), eq(hostedAccounts.did, did)))
		.limit(1);
	if (existing) {
		console.log(JSON.stringify({ did, handle, recorded: false, reason: "already_recorded" }));
		return;
	}

	// One call proves the account is on this node and that the password opens it. A PDS that
	// does not hold the account cannot answer this, and one that does not know the DID says so.
	const response = await fetch(new URL("/xrpc/com.atproto.server.createSession", nodeUrl), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: did, password }),
	});
	if (!response.ok) {
		const detail = (await response.json().catch(() => ({}))) as {
			error?: string;
			message?: string;
		};
		console.log(
			JSON.stringify({
				did,
				handle,
				recorded: false,
				reason: "session_refused",
				status: response.status,
				error: detail.error ?? null,
				message: detail.message ?? null,
			}),
		);
		process.exitCode = 1;
		return;
	}
	// The session is the credential the row keeps; the password is only how this run proved and
	// obtained it.
	const answered = (await response.json().catch(() => ({}))) as {
		accessJwt?: string;
		refreshJwt?: string;
	};
	if (!answered.accessJwt || !answered.refreshJwt) {
		console.log(JSON.stringify({ did, handle, recorded: false, reason: "session_unanswered" }));
		process.exitCode = 1;
		return;
	}

	await recordHostedIdentity(userId, {
		did,
		handle,
		session: { accessJwt: answered.accessJwt, refreshJwt: answered.refreshJwt },
	});

	// The account's own row still describes the host it came from: `atproto_pds_url` pointed at
	// the old PDS after the move. Writing it here keeps the row true, and nothing depends on it
	// for choosing a writer (that reads `hosted_accounts`) — which is exactly why it went stale
	// unnoticed.
	await db
		.update(users)
		.set({ atprotoPdsUrl: nodeUrl, atprotoHandle: handle })
		.where(eq(users.id, userId));

	console.log(JSON.stringify({ did, handle, recorded: true, atprotoPdsUrl: nodeUrl }));
}

await main();
