// SPDX-License-Identifier: Apache-2.0
/**
 * Seating a rotation key the account holder controls, above the two Anthers holds.
 *
 * ⭐ **This is the escape route the hosting offer promises, and until it existed the promise
 * was a description.** An identity Anthers issues carries two rotation keys, both Anthers'. A
 * third, ranked above them, is what lets somebody move their identity elsewhere without
 * Anthers' cooperation and against its wishes if it came to that.
 *
 * 🚨 **Anthers never sees the private half, and the flow is shaped around that.** The keypair
 * is generated in the browser (`apps/web/src/lib/recovery-key.ts`); only the `did:key:` public
 * half is sent here. A key Anthers generated and handed over would be a key Anthers had held,
 * which is exactly the thing it exists to protect somebody from.
 *
 * 🚨 **The node signs, not the hub, and that is a security property rather than an
 * inconvenience.** A PLC operation must be signed by a key already in the rotation list, and
 * the hub deliberately holds neither of Anthers' — the offline one is off the droplet
 * entirely, the online one lives inside the Personal Data Server. So the hub holds every
 * hosted account's password and still cannot MOVE an identity, only use it. Putting a rotation
 * key in the hub's environment would make this module about twenty lines shorter and would
 * mean a hub compromise could take every hosted identity permanently. That trade was declined
 * (Parker, 2026-09-09).
 *
 * ⚠️ **Which is why there are two steps and an emailed token in the middle.**
 * `com.atproto.identity.signPlcOperation` refuses without a token the node mails the account
 * holder, so the person proves control of their address before a key that outranks Anthers is
 * seated. That is not friction to design away — it is the right party authorizing the thing.
 * The node needs working mail for any of this; see the Production Operations Runbook.
 */
import { db } from "@anthers/db";
import { hostedAccounts, hostedIdentities } from "@anthers/db/schema";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { eq } from "drizzle-orm";
import { nodeCall, recordRecoveryKey } from "./hosted-accounts.js";
import { readIdentityHead } from "./hosted-identity.js";
import { open } from "./secret-box.js";

/** The base58btc alphabet — Bitcoin's ordering, which is what multibase `z` means. */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Uint8Array | null {
	let n = 0n;
	for (const ch of input) {
		const index = BASE58.indexOf(ch);
		if (index < 0) return null;
		n = n * 58n + BigInt(index);
	}
	const bytes: number[] = [];
	while (n > 0n) {
		bytes.unshift(Number(n % 256n));
		n /= 256n;
	}
	for (const ch of input) {
		if (ch !== "1") break;
		bytes.unshift(0);
	}
	return Uint8Array.from(bytes);
}

/**
 * Whether this is really a secp256k1 public key, decoded rather than pattern-matched.
 *
 * 🚨 **A `did:key:` that is subtly wrong does not fail anywhere.** It is well-formed, the node
 * accepts it, the operation succeeds, and the identity ends up carrying a rotation key at the
 * TOP of its authority list that signs for nothing — discovered by the one person who needed
 * it, on the day they needed it, with no way left to fix it. A regex would pass every one of
 * those. So this decodes the multibase, checks the multicodec prefix, and asks the curve
 * whether the point is actually on it.
 *
 * ⚠️ **The browser already produced this correctly**, so nothing here is expected to fire in
 * normal use. It is here because the value arrives over the wire and the cost of accepting a
 * bad one is unrecoverable rather than annoying.
 */
export function isSecp256k1DidKey(didKey: string): boolean {
	if (!didKey.startsWith("did:key:z")) return false;
	const decoded = base58Decode(didKey.slice("did:key:z".length));
	// 2 bytes of multicodec prefix plus a 33-byte compressed point.
	if (!decoded || decoded.length !== 35) return false;
	if (decoded[0] !== 0xe7 || decoded[1] !== 0x01) return false;
	try {
		// Throws for a point that is not on the curve, which is the check a regex cannot make.
		secp256k1.Point.fromBytes(decoded.slice(2));
		return true;
	} catch {
		return false;
	}
}

/** Asking the node to mail the account holder a token. */
export type RecoveryKeyRequestResult =
	| { status: "sent" }
	| { status: "refused"; message: string; fault: "account" | "operational" };

/** Seating the key, once the holder has come back with the token. */
export type RecoveryKeySeatResult =
	| { status: "seated"; didKey: string; rotationKeys: string[] }
	| { status: "already-held"; didKey: string }
	| { status: "refused"; message: string; fault: "key" | "token" | "account" | "operational" };

/** Every refusal shape, so a helper that can only refuse says so in its type. */
type SeatRefusal = Extract<RecoveryKeySeatResult, { status: "refused" }>;

/** The hosted identity this account holds, opened and ready to act on. */
interface OpenedAccount {
	did: string;
	password: string;
}

/**
 * Find the account's hosted identity and open its credential.
 *
 * ⚠️ **An unopenable credential is an operational failure rather than the person's**, and it
 * is a real state: `signup-probe.anthers.social` is sealed under a key production does not
 * have. Retrying never opens it, so the message says somebody at Anthers has to act rather
 * than inviting the person to try again.
 */
async function openAccountFor(userId: number): Promise<OpenedAccount | SeatRefusal> {
	const [row] = await db
		.select({ did: hostedAccounts.did, sealedPassword: hostedAccounts.sealedPassword })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.userId, userId))
		.limit(1);
	if (!row) {
		return {
			status: "refused",
			fault: "account",
			message: "This account doesn't hold an identity Anthers issued.",
		};
	}
	// `open` THROWS on a value this deployment's key cannot open — it does not return empty —
	// which is the same handling `purgeHostedIdentity` uses for the same reason.
	let password: string;
	try {
		password = open(row.sealedPassword);
	} catch {
		console.error(
			`[recovery-key] cannot open the credential for ${row.did} — only the node's admin ` +
				`password can reach that account now`,
		);
		return {
			status: "refused",
			fault: "operational",
			message: "Anthers can't reach that identity right now. Nothing has changed.",
		};
	}
	return { did: row.did, password };
}

function isRefusal(v: OpenedAccount | SeatRefusal): v is SeatRefusal {
	return "status" in v;
}

/** Sign in to the node as the account. Returns the access token or a refusal. */
async function sessionFor(account: OpenedAccount, call: NodeCall): Promise<string | SeatRefusal> {
	const session = await call("/xrpc/com.atproto.server.createSession", {
		method: "POST",
		body: JSON.stringify({ identifier: account.did, password: account.password }),
	});
	if (!session.ok) {
		return {
			status: "refused",
			fault: "operational",
			message: "Anthers couldn't reach the identity server. Try again in a little while.",
		};
	}
	const token = session.body.accessJwt as string | undefined;
	if (!token) {
		return {
			status: "refused",
			fault: "operational",
			message: "The identity server answered without a session.",
		};
	}
	return token;
}

type NodeCall = (
	path: string,
	init: RequestInit & { token?: string },
) => Promise<
	{ ok: true; body: Record<string, unknown> } | { ok: false; retryable: boolean; error: string }
>;

/**
 * Bind the shared node caller to an injected fetch, so tests never touch the network.
 *
 * `nodeCall` is `hosted-accounts.ts`'s, deliberately: this module talks to the same server
 * about the same accounts, and a second opinion about which failures are retryable is how the
 * two would drift.
 */
function callerFor(doFetch: typeof fetch): NodeCall {
	return (path, init) => nodeCall(path, init, doFetch);
}

/**
 * Ask the node to mail this account holder a token for a PLC operation.
 *
 * ⚠️ **The token goes to them, not to Anthers, and that is the point.** The hub can sign into
 * the account — it holds the password — so if it could also read the token there would be no
 * second party in this at all, and a key that outranks Anthers would be seatable by Anthers
 * alone. The address it goes to is the one they proved at signup.
 */
export async function requestRecoveryKeyToken(
	userId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<RecoveryKeyRequestResult> {
	const nodeCall = callerFor(opts.fetchImpl ?? fetch);
	const opened = await openAccountFor(userId);
	if (isRefusal(opened)) {
		return { status: "refused", message: opened.message, fault: refusalFault(opened) };
	}

	const token = await sessionFor(opened, nodeCall);
	if (typeof token !== "string") {
		return { status: "refused", message: token.message, fault: refusalFault(token) };
	}

	const asked = await nodeCall("/xrpc/com.atproto.identity.requestPlcOperationSignature", {
		method: "POST",
		token,
	});
	if (!asked.ok) {
		return {
			status: "refused",
			fault: "operational",
			message: "Anthers couldn't send the confirmation code. Try again in a little while.",
		};
	}
	return { status: "sent" };
}

/** Narrow a seat refusal's fault to the two a request can produce. */
function refusalFault(r: SeatRefusal): "account" | "operational" {
	return r.fault === "account" ? "account" : "operational";
}

/**
 * Seat the holder's key at the head of the rotation list.
 *
 * ⚠️ **The whole list is sent, not the one new key.** `signPlcOperation` replaces
 * `rotationKeys` wholesale with whatever it is given, so the current list has to be read and
 * the new key prepended — and it is read from the **PLC directory**, live, rather than from
 * the row the watcher keeps. That row is a baseline for noticing change and can be an hour
 * stale; building an operation on a stale list would silently drop whatever it missed.
 *
 * 🚨 **`submitPlcOperation` refuses a list that drops the node's own key**, which is what makes
 * this safe to build from a read: Anthers can seat a key ABOVE its own and cannot remove itself
 * this way even by accident.
 */
export async function seatRecoveryKey(
	userId: number,
	input: { token: string; didKey: string },
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<RecoveryKeySeatResult> {
	if (!isSecp256k1DidKey(input.didKey)) {
		return {
			status: "refused",
			fault: "key",
			message: "That isn't a key this server can use. Generate a new one and try again.",
		};
	}

	const doFetch = opts.fetchImpl ?? fetch;
	const nodeCall = callerFor(doFetch);
	const opened = await openAccountFor(userId);
	if (isRefusal(opened)) return opened;

	// ⚠️ The injected fetch is threaded here too. Reading the directory with the real one while
	// the node is faked is how a test passes against a live third party without saying so.
	const head = await readIdentityHead(opened.did, { fetchImpl: doFetch });
	if (!head) {
		return {
			status: "refused",
			fault: "operational",
			message: "Anthers couldn't read your identity's public record just now. Try again shortly.",
		};
	}
	// Idempotent: somebody pressing twice, or coming back to a flow they already finished, is
	// told they hold it rather than seating a duplicate at the head of the list.
	if (head.rotationKeys.includes(input.didKey)) {
		return { status: "already-held", didKey: input.didKey };
	}

	const token = await sessionFor(opened, nodeCall);
	if (typeof token !== "string") return token;

	const signed = await nodeCall("/xrpc/com.atproto.identity.signPlcOperation", {
		method: "POST",
		token,
		body: JSON.stringify({
			token: input.token,
			rotationKeys: [input.didKey, ...head.rotationKeys],
		}),
	});
	if (!signed.ok) {
		// ⚠️ A wrong or expired token is the ordinary case here and is the person's to fix, so it
		// must not be reported as an outage. Anything the node refuses outright is treated that
		// way; only an unreachable node is operational.
		if (signed.retryable) {
			return {
				status: "refused",
				fault: "operational",
				message: "Anthers couldn't reach the identity server. Try again in a little while.",
			};
		}
		return {
			status: "refused",
			fault: "token",
			message: "That code didn't work. Codes expire, so ask for a new one and try again.",
		};
	}

	const operation = signed.body.operation;
	if (!operation) {
		return {
			status: "refused",
			fault: "operational",
			message: "The identity server signed nothing. Nothing has changed.",
		};
	}

	const submitted = await nodeCall("/xrpc/com.atproto.identity.submitPlcOperation", {
		method: "POST",
		token,
		body: JSON.stringify({ operation }),
	});
	if (!submitted.ok) {
		return {
			status: "refused",
			fault: "operational",
			message: "The identity server wouldn't publish the change. Nothing has changed.",
		};
	}

	// The record of what Anthers did, which is what lets settings answer "have I done this?"
	// without reading custody off the length of a list. See the column's own note for why the
	// rotation list is the truth and this is only a record.
	//
	// ⚠️ Written through `hosted-accounts.ts` rather than here, because that module is the only
	// writer of `hosted_accounts` — the one-writer rule in the Agents Hub, which this module
	// broke by updating the column directly when it was first written.
	await recordRecoveryKey(opened.did, input.didKey);

	// ⭐ **Re-read and store the new head, or the watcher pages somebody about this.**
	// `watch-identities` alerts on any rotation-key change, which is exactly right for a key
	// that moved without Anthers doing it — and this one moved BECAUSE Anthers did it, on the
	// account holder's instruction. Writing the new baseline now is the difference between a
	// deliberate act and a suspected compromise. A directory that has not caught up yet leaves
	// it to the sweep, which is the behavior that was there before.
	const after = await readIdentityHead(opened.did, { fetchImpl: doFetch });
	if (after) {
		await db
			.update(hostedIdentities)
			.set({
				rotationKeys: after.rotationKeys,
				headCid: after.headCid,
				handle: after.handle,
				pdsEndpoint: after.pdsEndpoint,
				lastCheckedAt: new Date(),
			})
			.where(eq(hostedIdentities.did, opened.did));
	} else {
		console.warn(
			`[recovery-key] seated a key on ${opened.did} but could not re-read the directory — ` +
				`the watcher will report this as a change it did not expect`,
		);
	}

	return {
		status: "seated",
		didKey: input.didKey,
		rotationKeys: after?.rotationKeys ?? [input.didKey, ...head.rotationKeys],
	};
}

/** What settings needs to know before it offers anything. */
export interface RecoveryKeyState {
	/** Whether this account holds an identity Anthers issued at all. */
	hosted: boolean;
	/** The key taken through Anthers, if one was. Public, and in the PLC log regardless. */
	didKey: string | null;
	seatedAt: string | null;
}

/**
 * What Anthers knows about this account's recovery key.
 *
 * ⚠️ **`didKey: null` means Anthers did not seat one, not that none exists.** Somebody who
 * seated a key with their own tooling did exactly what this arrangement promises they can, and
 * the identity's rotation list is the authority on what it carries. Settings uses this to
 * decide what to OFFER, which is the one question it can answer honestly.
 */
export async function recoveryKeyState(userId: number): Promise<RecoveryKeyState> {
	const [row] = await db
		.select({
			key: hostedAccounts.recoveryKey,
			seatedAt: hostedAccounts.recoveryKeySeatedAt,
		})
		.from(hostedAccounts)
		.where(eq(hostedAccounts.userId, userId))
		.limit(1);
	if (!row) return { hosted: false, didKey: null, seatedAt: null };
	return {
		hosted: true,
		didKey: row.key,
		seatedAt: row.seatedAt ? row.seatedAt.toISOString() : null,
	};
}
