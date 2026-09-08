// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Issuing an identity on the Personal Data Server Anthers runs.
 *
 * `hosted-identity.ts` watches identities that already exist; this module is the other half
 * and creates them. It is the only place an account is created on the node, and the only
 * place the credentials for one are written down.
 *
 * ⭐ **Why hosting is a feature at all, since nobody is turned away without it.** A record
 * has to live in the creator's own repository, and writing into a repository Anthers does not
 * host would need `transition:generic` — a scope that grants everything, which is not a thing
 * to ask a creator for. So a creator without an Anthers-hosted identity cannot have the
 * protocol half at all. Hosting is what makes records work for anybody rather than for
 * nobody, and the third door at signup is what makes hosting reachable.
 *
 * 🚨 **No recovery key is issued here, and that is a decision rather than an omission**
 * (Parker, 2026-09-08). The protocol would let Anthers seat a key the account holder controls
 * above its own two at creation time, and the reason not to is that a key somebody loses is
 * worse than one they never had: it sits at the top of the authority list where nobody can
 * use it, the escape it was meant to be is gone, and nothing says so. Taking one is a
 * deliberate step in settings instead. Nothing is foreclosed by waiting — a key already in
 * the list can seat a new one above itself, which was tested against the live directory using
 * Anthers' own lowest-ranked key. Until somebody takes theirs, **Anthers holds the only keys
 * to their identity**, which the offer says plainly rather than leaving them to assume.
 *
 * ⚠️ **The node is always the authority on a name.** Everything here that decides a handle is
 * unavailable before asking is an optimization for how early the answer arrives, never a
 * second policy — see `hosted-handle-reserved.ts`.
 */
import { db } from "@anthers/db";
import { hostedAccounts, hostedIdentities } from "@anthers/db/schema";
import { PDS_RESERVED_HANDLE_NAMES } from "./hosted-handle-reserved.js";
import { readIdentityHead } from "./hosted-identity.js";
import { seal, secretBoxConfigured } from "./secret-box.js";

/** Where the Anthers-run Personal Data Server answers, or the empty string when unset. */
function pdsUrl(): string {
	return process.env.HOSTED_PDS_URL?.trim() ?? "";
}

/**
 * The invite code the node requires of anybody creating an account on it.
 *
 * 🚨 **This is deliberately an invite code and NOT the node's admin password.** Both would
 * work — minting a code per signup is what the admin password would be for — and they differ
 * enormously in what a leak costs. An invite code can create accounts and nothing else; the
 * admin password can reset any account's password, change any handle and delete any account,
 * so putting it in the hub's environment would make a hub compromise a node compromise for
 * everybody hosted there. The code is minted once by hand on the node with a `useCount` large
 * enough to last, and replacing it is one command.
 *
 * ⚠️ **It runs out silently from out here.** `createAccount` answers `InvalidInviteCode` when
 * the count is spent, which {@link createHostedAccount} reports as an operational failure
 * rather than as the person's fault — because it is not their fault, and the alert is the only
 * thing that will bring anybody to mint a new one.
 */
function inviteCode(): string {
	return process.env.HOSTED_PDS_INVITE_CODE?.trim() ?? "";
}

/**
 * The suffix issued handles hang under, derived from the server's own hostname.
 *
 * 🚨 It is `anthers.social` and never a subdomain of `anthers.org`. The session cookie is
 * issued with `Domain=.anthers.org`, so a browser sends it to every subdomain — issuing
 * user-controlled names inside that boundary would hand each holder a place the browser is
 * willing to send somebody else's session. The separate domain is what keeps a naming
 * decision from being an account-takeover surface.
 *
 * ⚠️ Derived rather than configured, because a second variable is a second thing that can
 * disagree with the server. The node's own `describeServer` reports `availableUserDomains`
 * and is the authority if they ever differ.
 */
export function hostedHandleSuffix(): string {
	const url = pdsUrl();
	if (!url) return "";
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/**
 * Whether Anthers can actually issue an identity right now.
 *
 * ⚠️ **Every piece has to be present, and the door is closed if any is missing.** A door that
 * refuses when pressed is worse than no door — the same reason `atprotoSignupEnabled` is read
 * by the browser as well as by the server. The pieces are: a server to create the account on,
 * a credential it will accept, and a key to seal the account's password with. Missing any one
 * of them means an account that cannot be created, or one created and immediately
 * unreachable.
 *
 * ⚠️ Every piece is read at call time rather than at import, so an API that boots without any
 * of this configured is an API with the door closed rather than one that will not start.
 */
export function hostedIdentityOffered(): boolean {
	return !!pdsUrl() && !!inviteCode() && !!hostedHandleSuffix() && secretBoxConfigured();
}

/** The full handle a requested name would become. */
export function hostedHandleFor(name: string): string {
	return `${name}.${hostedHandleSuffix()}`;
}

/**
 * Turn whatever somebody typed into the name part of a handle.
 *
 * People write handles several ways and none of them are wrong: with a leading `@`, with the
 * suffix already on the end, in the case they think in. Stripping all of that on the way in
 * means the field never fights anybody, which is the same argument the Bluesky door's handle
 * input makes about its own leading `@`.
 */
export function normalizeHandleName(raw: string): string {
	let value = raw.trim().toLowerCase().replace(/^@/, "");
	const suffix = `.${hostedHandleSuffix()}`;
	if (suffix.length > 1 && value.endsWith(suffix)) {
		value = value.slice(0, -suffix.length);
	}
	return value;
}

/** The shortest name Anthers will issue. Two characters is a namespace worth squatting in. */
const MIN_HANDLE_NAME = 3;
/**
 * The longest. A DNS label may be 63 characters and a handle 253, so this is Anthers' limit
 * rather than the protocol's — a name has to be sayable, and nobody is served by a 63-
 * character one.
 */
const MAX_HANDLE_NAME = 30;

/**
 * Names Anthers refuses on top of the node's own list.
 *
 * The node's list already covers most of what matters, including `admin`, `abuse` and
 * `support`. These are the ones specific to what Anthers publishes and answers to, where a
 * handle that looks official is the whole hazard.
 */
const ANTHERS_RESERVED_HANDLE_NAMES = new Set([
	"anthers",
	"anthersorg",
	"anthersteam",
	"anthersinc",
	"anthersofficial",
	"anthershelp",
	"antherssupport",
	"parkerhdavis",
	"keeper",
	"keepers",
	"timepool",
	"badge",
	"badges",
]);

const RESERVED = new Set<string>([...PDS_RESERVED_HANDLE_NAMES, ...ANTHERS_RESERVED_HANDLE_NAMES]);

/**
 * Why this name cannot be issued, or null when nothing about the name itself refuses it.
 *
 * Pure, and therefore the part of this module that is cheap to test exhaustively. It answers
 * sentences rather than codes because every one of them is shown to whoever typed the name,
 * and there is nothing here a caller needs to branch on.
 */
export function handleNameProblem(name: string): string | null {
	if (name.length < MIN_HANDLE_NAME) {
		return `A handle needs at least ${MIN_HANDLE_NAME} characters.`;
	}
	if (name.length > MAX_HANDLE_NAME) {
		return `A handle can be at most ${MAX_HANDLE_NAME} characters.`;
	}
	// A handle is a domain name, so the alphabet is a DNS label's rather than a username's.
	// ⚠️ Underscores are the one people are surprised by, because Anthers usernames allow
	// them — so the message names the character instead of restating the rule.
	if (name.includes("_")) {
		// ⚠️ Kept short as well as specific: this is the longest of these messages, and it sits
		// in a fixed two-line region under the field. A third line would grow the panel.
		return "A handle is a web address, so no underscores. Use a hyphen.";
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		return "A handle can only contain letters, numbers and hyphens.";
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		return "A handle can't start or end with a hyphen.";
	}
	if (RESERVED.has(name)) {
		return "That handle is reserved.";
	}
	return null;
}

/**
 * What is known about a requested name.
 *
 * 🚨 **`unknown` is load-bearing and must not be collapsed into `taken`.** A node that did not
 * answer has said nothing about whether a name is free, and treating silence as a refusal
 * would tell somebody their name was gone during an outage — the same distinction
 * `listHostedRepos` draws between `null` and `[]`, for the same reason.
 */
export type HandleAvailability =
	| { status: "invalid"; problem: string }
	| { status: "taken" }
	| { status: "available" }
	| { status: "unknown" };

/**
 * Ask the node whether a name is free.
 *
 * `com.atproto.identity.resolveHandle` answers with a DID for a handle that exists and
 * refuses for one that does not, which makes "refused" the available case. That reads
 * backwards and is worth the comment rather than the reader deriving it.
 */
export async function checkHandleAvailability(
	name: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<HandleAvailability> {
	const problem = handleNameProblem(name);
	if (problem) return { status: "invalid", problem };

	const url = pdsUrl();
	if (!url) return { status: "unknown" };

	const doFetch = opts.fetchImpl ?? fetch;
	try {
		const endpoint = new URL(`${url}/xrpc/com.atproto.identity.resolveHandle`);
		endpoint.searchParams.set("handle", hostedHandleFor(name));
		const res = await doFetch(endpoint.toString(), { signal: AbortSignal.timeout(10_000) });
		if (res.ok) return { status: "taken" };
		// A 400 is the node saying it cannot resolve that handle, which is what free looks
		// like. Anything else is the node having a problem rather than an answer about a name.
		if (res.status === 400) return { status: "available" };
		return { status: "unknown" };
	} catch {
		return { status: "unknown" };
	}
}

/** An identity the node has just created. */
export interface HostedAccount {
	did: string;
	handle: string;
	/** The account's password at the node, in the clear. The caller seals it and forgets it. */
	password: string;
}

/**
 * Why creating an account failed, and whose problem it is.
 *
 * ⚠️ **The distinction is what decides who gets told.** `name` means the person can fix it by
 * choosing again; `operational` means they cannot fix it at all and somebody at Anthers has to
 * — a spent invite code, a node that is down. Reporting the second as though it were the first
 * would leave somebody retyping a name that was never the problem.
 */
export class HostedAccountError extends Error {
	constructor(
		message: string,
		readonly fault: "name" | "operational",
	) {
		super(message);
		this.name = "HostedAccountError";
	}
}

/**
 * A password nobody will ever type.
 *
 * 24 bytes of randomness, which is far past anything a password policy asks for, because this
 * one is generated and stored rather than remembered. It is base64url so that it survives
 * being pasted anywhere without escaping.
 */
function generatePassword(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

/**
 * Create an account on the node.
 *
 * ⚠️ **The address given to the node is the one the person just proved to Anthers**, and it
 * has to be: the node needs a contact address per account, and inventing one would make the
 * account unreachable for a password reset it may one day need. The node is Anthers' own
 * machine, so this hands nothing to a third party — but it does mean an address already used
 * by an account on the node is refused, which is why that case has its own message.
 *
 * 🚨 **`recoveryKey` is deliberately not passed** — see the module note.
 */
export async function createHostedAccount(
	input: { handleName: string; email: string },
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<HostedAccount> {
	const url = pdsUrl();
	const code = inviteCode();
	if (!url || !code) {
		throw new HostedAccountError("Anthers isn't issuing handles right now.", "operational");
	}

	const problem = handleNameProblem(input.handleName);
	if (problem) throw new HostedAccountError(problem, "name");

	const password = generatePassword();
	const doFetch = opts.fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await doFetch(`${url}/xrpc/com.atproto.server.createAccount`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: hostedHandleFor(input.handleName),
				email: input.email,
				password,
				inviteCode: code,
			}),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new HostedAccountError("Couldn't reach the handle server.", "operational");
	}

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
		throw refusalOf(body.error, body.message);
	}

	const body = (await res.json()) as { did?: string; handle?: string };
	if (!body.did || !body.handle) {
		throw new HostedAccountError("The handle server answered with no identity.", "operational");
	}
	return { did: body.did, handle: body.handle, password };
}

/**
 * Turn the node's refusal into something the right person can act on.
 *
 * The node's own messages are accurate and written for whoever operates a server, which is the
 * same shape of problem the Bluesky handoff's `startFailureMessage` solves: the one common case
 * gets copy, and the rest pass through rather than being flattened into an apology that throws
 * away the only clue anybody has.
 */
function refusalOf(error: string | undefined, message: string | undefined): HostedAccountError {
	switch (error) {
		case "HandleNotAvailable":
			return new HostedAccountError("That handle has just been taken. Try another.", "name");
		case "InvalidHandle":
			return new HostedAccountError("That handle isn't one the server will issue.", "name");
		case "InvalidInviteCode":
			// Not the person's fault and not fixable by them: the code is spent or wrong.
			return new HostedAccountError("The handle server refused Anthers' invite.", "operational");
		case "EmailNotAvailable":
			return new HostedAccountError(
				"There's already an identity on the handle server for that address.",
				"operational",
			);
		default:
			return new HostedAccountError(
				message || "The handle server refused to create the account.",
				"operational",
			);
	}
}

// ─── Issuing one, and writing down what came back ────────────────────────────

/** What provisioning did. `null` on the handle means nothing was issued. */
export interface ProvisionResult {
	did: string | null;
	handle: string | null;
	/** Why it did not happen, for the person who asked or for whoever operates Anthers. */
	error?: { message: string; fault: "name" | "operational" };
}

/**
 * Issue an identity to an account that already exists, and record everything about it.
 *
 * 🚨 **Called only after the address has been proved**, which is what makes this safe to run
 * unattended. An identity issued from a typed address would be an identity bound to whoever
 * typed it, and the whole signup ceremony exists to stop that — see
 * `services/pending-signups.ts`.
 *
 * ⚠️ **Nothing here may throw into a signup.** An account that has just come into existence
 * is not improved by failing at the last step over a handle: the person keeps the account they
 * asked for, and the identity is something they can ask for again from settings. Every failure
 * therefore comes back as a value.
 *
 * Four things are written, in an order chosen so a crash leaves the smallest mess. The
 * credentials go down first, because an identity whose password was never stored is the one
 * failure nobody can undo from outside. The link and the watch row follow.
 */
export async function provisionHostedIdentity(input: {
	userId: number;
	handleName: string;
	email: string;
}): Promise<ProvisionResult> {
	if (!hostedIdentityOffered()) {
		return {
			did: null,
			handle: null,
			error: { message: "Anthers isn't issuing handles right now.", fault: "operational" },
		};
	}

	let account: HostedAccount;
	try {
		account = await createHostedAccount({ handleName: input.handleName, email: input.email });
	} catch (err) {
		if (err instanceof HostedAccountError) {
			return { did: null, handle: null, error: { message: err.message, fault: err.fault } };
		}
		console.error("[hosted-accounts] account creation failed:", err);
		return {
			did: null,
			handle: null,
			error: { message: "Couldn't create the handle.", fault: "operational" },
		};
	}

	// First, because this is the only copy. Everything below can be reconstructed by looking
	// at the node; a password that was never written down cannot be.
	await db
		.insert(hostedAccounts)
		.values({
			did: account.did,
			userId: input.userId,
			handle: account.handle,
			sealedPassword: seal(account.password),
		})
		.onConflictDoNothing();

	const { linkAtprotoToUser } = await import("./atproto.js");
	const linked = await linkAtprotoToUser(input.userId, {
		did: account.did,
		handle: account.handle,
		pdsUrl: pdsUrl(),
	});
	if (linked.error) {
		// Unreachable in practice — the DID was minted a moment ago, so nothing else can hold
		// it — and reported rather than asserted, because the alternative to noticing is an
		// identity that exists and belongs to nobody.
		console.error(`[hosted-accounts] could not link ${account.did}: ${linked.error}`);
	}

	// ⭐ **Watched from the first minute rather than from the next sweep.** `watch-identities`
	// would find this within the hour on its own, and would then record whatever it found as
	// the first sighting — so an operation signed in between would become the baseline instead
	// of an alert. Reading the head now makes the identity as issued the thing every later run
	// is compared against. A directory that has not caught up yet simply leaves it to the
	// sweep, which is the behavior that was there before.
	const observed = await readIdentityHead(account.did);
	if (observed) {
		await db
			.insert(hostedIdentities)
			.values({
				did: account.did,
				handle: observed.handle,
				pdsEndpoint: observed.pdsEndpoint,
				headCid: observed.headCid,
				lastCheckedAt: new Date(),
				lastListedAt: new Date(),
			})
			.onConflictDoNothing();
	}

	return { did: account.did, handle: account.handle };
}
