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
import { hostedAccounts, hostedIdentities, users } from "@anthers/db/schema";
import {
	handleSyntaxProblem,
	normalizeHandleName as sharedNormalize,
} from "@anthers/shared/handles";
import { eq } from "drizzle-orm";
import { PDS_RESERVED_HANDLE_NAMES } from "./hosted-handle-reserved.js";
import { readIdentityHead } from "./hosted-identity.js";
import { open, seal, secretBoxConfigured } from "./secret-box.js";

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
 * The rule is `@anthers/shared/handles`'; this only supplies the suffix, which that module
 * takes as an argument because a browser learns it from the API and a server derives it from
 * the node's own URL.
 */
export function normalizeHandleName(raw: string): string {
	return sharedNormalize(raw, hostedHandleSuffix());
}

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
	// ⭐ **Syntax first, and it is shared with the browser.** The card runs the same check as
	// somebody types, so a name with an underscore in it never becomes a request at all — see
	// `@anthers/shared/handles` for why only this half is shared.
	const syntax = handleSyntaxProblem(name);
	if (syntax) return syntax;
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
	//
	// ⚠️ **The conflict clause is defensive and the log under it is the point.** The DID was
	// minted a moment ago, so a row cannot already exist — but `onConflictDoNothing` would
	// swallow it if one somehow did, and what it would be swallowing is the only copy of a
	// password nobody has ever seen. A silent no-op here produces an identity only the node's
	// admin password can ever open, so it says so instead.
	const stored = await db
		.insert(hostedAccounts)
		.values({
			did: account.did,
			userId: input.userId,
			handle: account.handle,
			sealedPassword: seal(account.password),
		})
		.onConflictDoNothing()
		.returning({ did: hostedAccounts.did });
	if (stored.length === 0) {
		console.error(
			`[hosted-accounts] ${account.did} already had a credential row — the password just ` +
				`generated for it was NOT stored and cannot be recovered`,
		);
	}

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

// ─── Asking for one later ────────────────────────────────────────────────────

/**
 * What came of an account asking for a handle after it already existed.
 *
 * ⚠️ **`fault` decides who is being told and what they can do about it.** `name` means try
 * another one, `account` means this account is not eligible and no name would change that, and
 * `operational` means nothing about the request was wrong and somebody at Anthers has to act.
 * Flattening the three into one error would leave somebody retyping a name that was never the
 * problem — the same distinction {@link HostedAccountError} draws, widened by the one case that
 * only exists once an account is in the picture.
 */
export type HandleRequestResult =
	| { status: "issued"; did: string; handle: string }
	| { status: "refused"; message: string; fault: "name" | "account" | "operational" };

/**
 * Accounts with an identity being issued to them at this moment.
 *
 * ⚠️ **It covers a repeated press and not a distributed race**, and the difference is worth
 * being honest about: this process is one of several, so two requests landing on two instances
 * inside the node round trip would both pass. What that costs is a spare identity rather than a
 * broken account — both are written down, both are linked to the user, the later link wins, and
 * `releaseHostedIdentities` finds every row by `user_id` regardless of which one the account
 * signs in as. The realistic case is one person pressing twice, and this is what answers it.
 */
const beingIssued = new Set<number>();

/**
 * Issue a handle to an account that already exists, if it may have one.
 *
 * 🚨 **This is not a signup door and must never become one.** It acts on an account that is
 * already signed in, which is what makes it a different thing from `/subscribe` rather than a
 * second copy of it — and the guard is the session the route requires, not that the page is
 * hard to find.
 *
 * ⚠️ **An account that already holds an identity is refused rather than migrated.** Somebody
 * who signed in with Bluesky has a DID, and issuing a second would leave them holding two with
 * nothing saying which one is theirs; swapping one for the other is a real question about what
 * happens to the records under the first, and it is not this. Refusing plainly leaves that
 * question open, which is the point.
 *
 * ⚠️ **The address has to be proved, for the same reason it is proved at signup.** The node is
 * given the account's address and binds the identity to it, so issuing one from an address
 * nobody confirmed would bind an identity to whoever typed it.
 */
export async function requestHostedHandle(input: {
	userId: number;
	handleName: string;
}): Promise<HandleRequestResult> {
	if (!hostedIdentityOffered()) {
		return {
			status: "refused",
			fault: "operational",
			message: "Anthers isn't issuing handles right now.",
		};
	}

	const [account] = await db
		.select({
			email: users.email,
			emailVerified: users.emailVerified,
			atprotoDid: users.atprotoDid,
			atprotoHandle: users.atprotoHandle,
		})
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);
	if (!account) {
		return { status: "refused", fault: "account", message: "Account not found." };
	}

	// ⚠️ **Asked first, and separately from the DID, because they are different refusals.** A
	// credential row with no link on the account is what a provisioning that half-failed leaves
	// behind, and issuing a second identity over the top of it would strand the first — an
	// account on the node whose password is stored against a user who cannot see it.
	const held = await hostedHandlesFor(input.userId);
	if (held.length > 0) {
		return {
			status: "refused",
			fault: "account",
			message: `Anthers has already issued you ${held[0]}.`,
		};
	}

	if (account.atprotoDid) {
		return {
			status: "refused",
			fault: "account",
			message: `This account already signs in as ${
				account.atprotoHandle || account.atprotoDid
			}, an identity on another server. Unlink it first if you want an Anthers handle instead.`,
		};
	}

	if (!account.emailVerified) {
		return {
			status: "refused",
			fault: "account",
			message: "Confirm your email address first — the identity is created with it.",
		};
	}

	if (beingIssued.has(input.userId)) {
		return {
			status: "refused",
			fault: "account",
			message: "A handle is already on its way for this account.",
		};
	}
	beingIssued.add(input.userId);
	try {
		const result = await provisionHostedIdentity({
			userId: input.userId,
			handleName: normalizeHandleName(input.handleName),
			email: account.email,
		});
		if (result.error) {
			return { status: "refused", fault: result.error.fault, message: result.error.message };
		}
		if (!result.did || !result.handle) {
			// Unreachable: provisioning reports every failure as an error rather than as a blank
			// success. Answered rather than asserted, because the alternative is a route that
			// reports success while the caller has nothing to show.
			return {
				status: "refused",
				fault: "operational",
				message: "The handle server answered with no identity.",
			};
		}
		return { status: "issued", did: result.did, handle: result.handle };
	} finally {
		beingIssued.delete(input.userId);
	}
}

/**
 * Whether this DID is one Anthers issued and still holds the credentials to.
 *
 * 🚨 **What reads it is the unlink route**, which must refuse for a hosted identity: unlinking
 * is for an identity that lives somewhere else and carries on existing without Anthers, and
 * doing it to this one would detach somebody from a repository Anthers is still hosting on
 * their behalf and still holds the only password to. It would look like a tidy way to leave
 * and would leave nothing.
 */
export async function isHostedIdentity(did: string): Promise<boolean> {
	const [row] = await db
		.select({ did: hostedAccounts.did })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.did, did))
		.limit(1);
	return !!row;
}

// ─── Giving one back ─────────────────────────────────────────────────────────

/**
 * Erasing a hosted identity, which is the other end of the lifecycle above.
 *
 * 🚨 **The node will not destroy an account for anybody but an admin, and the hub is
 * deliberately not one.** `com.atproto.admin.deleteAccount` takes a DID and removes the
 * account, the repository, the blobs and the signing key in one call — and it needs the node's
 * admin password, which can also reset any account's password and rename any handle. Putting
 * that in the hub's environment would make a compromise of the hub a compromise of every
 * identity Anthers hosts, which is the whole reason accounts are created with an invite code
 * instead (see {@link inviteCode}). The other route, `com.atproto.server.deleteAccount`, wants
 * a token the node **emails** to the account, and the node has no mail configured.
 *
 * ⭐ **So the account is emptied rather than destroyed, using its own credential**, which the
 * hub does hold. Every record goes, and the blobs go with them because the reference server
 * dereferences a blob when the record naming it is deleted. The handle is replaced, so the
 * name somebody chose is both gone from the node and free for somebody else. The address is
 * replaced, which is the piece that actually matters — it is the only personal data in the
 * account row. Then the account is deactivated, and the hub drops the credential and stops
 * watching the identity.
 *
 * ⚠️ **What is left is a shell with no name, no address and no contents, plus a DID.** The DID
 * is in a public directory that nothing can delete from, so it survives every design including
 * the admin one; a person who took a recovery key can still sign for it, which is theirs
 * rather than Anthers' to end. `deletionPreview` says so before anybody presses the button.
 * Sweeping the empty shells off the node is an operator's chore rather than a privacy step,
 * because by then they hold nothing about anybody.
 *
 * ⚠️ **Order is not incidental.** Records first, because a deactivated repository refuses
 * writes — `applyWrites` checks it in the handler rather than in its auth. Deactivation last
 * for the same reason.
 */

/** How far the node got. Every value is a different thing for the caller to do. */
export type HostedPurgeOutcome =
	/** Emptied and deactivated, or already was. */
	| { status: "purged" }
	/** The node has no such account. Nothing is owed and nothing went wrong. */
	| { status: "absent" }
	/**
	 * The node could not be reached, or refused in a way that will pass.
	 *
	 * 🚨 **The caller must DEFER rather than shrug**, and this is the one place where that
	 * differs from `revokeAtprotoGrant` next door. That call is best-effort because a third
	 * party's outage is not a reason to refuse somebody their erasure. This is not a third
	 * party — it is Anthers' own machine holding that person's records, so an outage here is a
	 * reason to try again tomorrow, not a reason to declare the erasure done.
	 */
	| { status: "unreachable"; reason: string }
	/**
	 * There is an account and the hub cannot open it — a credential sealed under a key this
	 * deployment does not have, or a password the node no longer accepts.
	 *
	 * ⚠️ **Retrying never fixes this, so the caller must NOT defer on it.** Blocking somebody's
	 * erasure forever on a key nobody can use is worse than finishing without this step and
	 * saying loudly that a shell was left behind.
	 */
	| { status: "unusable"; reason: string };

/** One call to the node, with the two failure kinds kept apart. */
async function nodeCall(
	path: string,
	init: RequestInit & { token?: string },
	doFetch: typeof fetch,
): Promise<
	{ ok: true; body: Record<string, unknown> } | { ok: false; retryable: boolean; error: string }
> {
	const { token, ...rest } = init;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	let res: Response;
	try {
		res = await doFetch(`${pdsUrl()}${path}`, {
			...rest,
			headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		return { ok: false, retryable: true, error: err instanceof Error ? err.message : "no answer" };
	}
	if (res.ok) {
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { ok: true, body };
	}
	const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
	// A 5xx is the node having a bad day; a 4xx is the node's considered answer. Retrying the
	// first is the whole point, and retrying the second is a loop.
	return {
		ok: false,
		retryable: res.status >= 500 || res.status === 429,
		error: body.error || body.message || `HTTP ${res.status}`,
	};
}

/** A name that says only that something was here. Same token in both, so one row reads as one account. */
function purgeToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
}

/**
 * Empty one account on the node, using its own password.
 *
 * Every step is idempotent, because a run that fails partway is retried tomorrow: the records
 * are re-listed rather than remembered, and replacing an already-replaced handle or address
 * just replaces it again.
 */
export async function purgeHostedIdentity(
	did: string,
	sealedPassword: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<HostedPurgeOutcome> {
	if (!pdsUrl()) return { status: "unusable", reason: "no HOSTED_PDS_URL is configured" };
	const doFetch = opts.fetchImpl ?? fetch;

	let password: string;
	try {
		password = open(sealedPassword);
	} catch (err) {
		return {
			status: "unusable",
			reason: `the sealed password could not be opened (${err instanceof Error ? err.message : "unknown"})`,
		};
	}

	// Asked first because it is also how the collections are enumerated, so it costs nothing
	// beyond what the record deletion needs anyway.
	const described = await nodeCall(
		`/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`,
		{ method: "GET" },
		doFetch,
	);
	let collections: string[] = [];
	let alreadyDeactivated = false;
	if (described.ok) {
		collections = ((described.body.collections as string[] | undefined) ?? []).filter(Boolean);
	} else if (described.error === "RepoNotFound" || described.error === "AccountNotFound") {
		// Migrated away, or an operator already removed it. Nothing here is owed.
		return { status: "absent" };
	} else if (described.error === "RepoDeactivated" || described.error === "RepoTakendown") {
		// A previous run got as far as deactivating, so the records are already gone and the
		// repository will refuse writes anyway. Carry on and finish the rest.
		alreadyDeactivated = true;
	} else if (described.retryable) {
		return { status: "unreachable", reason: `describeRepo: ${described.error}` };
	} else {
		return { status: "unusable", reason: `describeRepo: ${described.error}` };
	}

	const session = await nodeCall(
		"/xrpc/com.atproto.server.createSession",
		{ method: "POST", body: JSON.stringify({ identifier: did, password }) },
		doFetch,
	);
	if (!session.ok) {
		if (session.retryable)
			return { status: "unreachable", reason: `createSession: ${session.error}` };
		return { status: "unusable", reason: `createSession: ${session.error}` };
	}
	const token = session.body.accessJwt as string | undefined;
	if (!token) return { status: "unusable", reason: "createSession answered with no token" };

	if (!alreadyDeactivated) {
		const emptied = await deleteEveryRecord(did, collections, token, doFetch);
		if (emptied) return emptied;
	}

	const mark = purgeToken();
	// The handle before the address, because a failure between them leaves the address — which
	// is the piece that matters — still to be dealt with by the retry rather than already done.
	const renamed = await nodeCall(
		"/xrpc/com.atproto.identity.updateHandle",
		{
			method: "POST",
			token,
			body: JSON.stringify({ handle: `deleted-${mark}.${hostedHandleSuffix()}` }),
		},
		doFetch,
	);
	if (!renamed.ok && renamed.retryable) {
		return { status: "unreachable", reason: `updateHandle: ${renamed.error}` };
	}

	const readdressed = await nodeCall(
		"/xrpc/com.atproto.server.updateEmail",
		{
			method: "POST",
			token,
			body: JSON.stringify({ email: `deleted-${mark}@${hostedHandleSuffix()}` }),
		},
		doFetch,
	);
	if (!readdressed.ok) {
		// 🚨 Not softened even when the node's refusal looks final. The address is the personal
		// data in that row, so an erasure that could not replace it has not finished, and saying
		// so leaves a retry to try again rather than reporting a job done.
		return { status: "unreachable", reason: `updateEmail: ${readdressed.error}` };
	}

	if (!alreadyDeactivated) {
		const off = await nodeCall(
			"/xrpc/com.atproto.server.deactivateAccount",
			{ method: "POST", token, body: JSON.stringify({}) },
			doFetch,
		);
		if (!off.ok && off.retryable) {
			return { status: "unreachable", reason: `deactivateAccount: ${off.error}` };
		}
	}

	return { status: "purged" };
}

/**
 * Delete every record in every collection, in the batches `applyWrites` accepts.
 *
 * Answers an outcome only when something went wrong; `null` means the repository is empty.
 * The listing is re-read each pass rather than paged through, because the deletes are changing
 * the thing being paged.
 */
async function deleteEveryRecord(
	did: string,
	collections: string[],
	token: string,
	doFetch: typeof fetch,
): Promise<HostedPurgeOutcome | null> {
	for (const collection of collections) {
		// A bound rather than a belief about how many records anybody has. 200 passes of 100 is
		// twenty thousand records, and stopping is better than a loop that never ends against a
		// node that has stopped deleting.
		for (let pass = 0; pass < 200; pass++) {
			const url =
				`/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}` +
				`&collection=${encodeURIComponent(collection)}&limit=100`;
			const listed = await nodeCall(url, { method: "GET" }, doFetch);
			if (!listed.ok) {
				if (listed.retryable)
					return { status: "unreachable", reason: `listRecords: ${listed.error}` };
				return { status: "unusable", reason: `listRecords: ${listed.error}` };
			}
			const records = (listed.body.records as Array<{ uri?: string }> | undefined) ?? [];
			if (records.length === 0) break;

			const writes = records
				.map((r) => r.uri?.split("/").pop())
				.filter((rkey): rkey is string => !!rkey)
				.map((rkey) => ({ $type: "com.atproto.repo.applyWrites#delete", collection, rkey }));
			if (writes.length === 0) break;

			const applied = await nodeCall(
				"/xrpc/com.atproto.repo.applyWrites",
				{ method: "POST", token, body: JSON.stringify({ repo: did, writes }) },
				doFetch,
			);
			if (!applied.ok) {
				if (applied.retryable)
					return { status: "unreachable", reason: `applyWrites: ${applied.error}` };
				return { status: "unusable", reason: `applyWrites: ${applied.error}` };
			}
		}
	}
	return null;
}

/** What releasing an account's hosted identities did, for the deletion job to act on. */
export type HostedRelease =
	/** This account had none. */
	| { status: "none" }
	/** Every identity it had is emptied, and the hub holds nothing about them. */
	| { status: "released"; handles: string[] }
	/** Try again. The caller must not treat the erasure as done. */
	| { status: "deferred"; reason: string }
	/** A shell was left on the node that the hub can never reach. Carry on and say so. */
	| { status: "stranded"; reason: string };

/**
 * Release every hosted identity belonging to one Anthers account.
 *
 * 🚨 **Read before the account row goes.** `hosted_accounts.user_id` is `set null` rather than
 * `cascade`, deliberately, so a deleted Anthers account cannot strand a live identity — which
 * means that after the wipe nothing joins the two and there is no way left to ask which
 * identities were this person's. Same ordering hazard the Works classification has, for the
 * same reason.
 *
 * 🚨 **And the rows go only once the node has actually let go.** The sealed password is the one
 * copy; dropping it while the identity still holds somebody's records would leave an account
 * only the node's admin password can ever open, which is the state the runbook describes for
 * `signup-probe` and does not want repeated on purpose.
 */
export async function releaseHostedIdentities(userId: number): Promise<HostedRelease> {
	const rows = await db
		.select({
			did: hostedAccounts.did,
			handle: hostedAccounts.handle,
			sealedPassword: hostedAccounts.sealedPassword,
		})
		.from(hostedAccounts)
		.where(eq(hostedAccounts.userId, userId));
	if (rows.length === 0) return { status: "none" };

	const released: string[] = [];
	const stranded: string[] = [];
	for (const row of rows) {
		const outcome = await purgeHostedIdentity(row.did, row.sealedPassword);
		if (outcome.status === "unreachable") {
			return { status: "deferred", reason: `${row.did}: ${outcome.reason}` };
		}
		if (outcome.status === "unusable") {
			stranded.push(`${row.did}: ${outcome.reason}`);
			continue;
		}
		// Purged or absent: there is nothing on the node this credential opens, so holding it is
		// keeping a secret about somebody who asked to be forgotten. The watch row goes with it,
		// because an identity nobody is hosting on anybody's behalf is not one to alert about.
		await db.delete(hostedAccounts).where(eq(hostedAccounts.did, row.did));
		await db.delete(hostedIdentities).where(eq(hostedIdentities.did, row.did));
		released.push(row.handle);
	}

	if (stranded.length > 0) return { status: "stranded", reason: stranded.join("; ") };
	return { status: "released", handles: released };
}

/** The handles this account was issued, for the confirmation screen. Empty when it has none. */
export async function hostedHandlesFor(userId: number): Promise<string[]> {
	const rows = await db
		.select({ handle: hostedAccounts.handle })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.userId, userId));
	return rows.map((r) => r.handle);
}
