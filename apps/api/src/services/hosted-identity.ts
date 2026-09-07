// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Watching the identity documents of accounts Anthers hosts.
 *
 * An identity on this network carries an ordered list of rotation keys, and a key ranked
 * higher can undo an operation signed by a lower one — but **only within 72 hours of it
 * happening.** After that the operation is permanent. So the remedy for a compromised
 * server key expires on a clock that starts without anybody being told, and the account
 * holder's key protects them only if somebody notices in time to use it.
 *
 * 🚨 **This is why the watcher lives in the hub and not on the server it watches.** A
 * watcher running beside the Personal Data Server is silenced by the same compromise it
 * exists to detect — the attacker who can sign operations can also stop the process that
 * would report them. The hub is separate infrastructure with a separate database, which is
 * the only arrangement where the alarm survives the event.
 *
 * ⭐ **The comparison is deliberately dumb.** It stores the identifier of the newest
 * operation in the identity's public audit log and shouts when it differs. It does not try
 * to decide whether a change was legitimate, because it cannot: a handle change, a
 * migration and a hostile takeover are the same shape from here, and a watcher that
 * guessed would eventually guess wrong in the direction of silence. A person reads the
 * alert and decides.
 */

/** What the audit log says about an identity right now. */
export interface ObservedIdentity {
	/** Identifier of the newest operation. The whole comparison. */
	headCid: string;
	/** The handle the identity currently claims. */
	handle: string | null;
	/** Where the identity says its repository lives. */
	pdsEndpoint: string | null;
}

/** What the hub recorded last time. `null` when this identity has never been seen. */
export interface StoredIdentity {
	did: string;
	headCid: string | null;
	handle: string | null;
	pdsEndpoint: string | null;
}

export interface AssessInput {
	did: string;
	stored: StoredIdentity | null;
	/**
	 * The audit log as read this run, or `null` when it could not be read.
	 *
	 * ⚠️ Unreadable is NOT a finding. A directory outage is not evidence about anybody's
	 * identity, and treating it as one would train whoever reads these alerts to skim them.
	 */
	observed: ObservedIdentity | null;
	/**
	 * Whether the hosting server listed this repository this run, or `null` when the
	 * listing itself failed.
	 *
	 * 🚨 The `null` case is load-bearing. An unreachable server and a server that has
	 * dropped an account look identical if you only check whether the DID was in the
	 * response, and alerting on the first would make the alert meaningless. Only a listing
	 * that SUCCEEDED and omitted a known identity is worth waking somebody for.
	 */
	listed: boolean | null;
}

export type IdentityFinding =
	/** Never seen before. Recorded, not alerted — there is nothing to compare against. */
	| { kind: "first-seen"; did: string; headCid: string }
	/** The audit log could not be read. Nothing is concluded. */
	| { kind: "unreadable"; did: string }
	/** Nothing moved. */
	| { kind: "unchanged"; did: string }
	/** Somebody signed an operation. This is the one the 72-hour clock is attached to. */
	| {
			kind: "changed";
			did: string;
			from: string | null;
			to: string;
			handleFrom: string | null;
			handleTo: string | null;
			endpointFrom: string | null;
			endpointTo: string | null;
	  }
	/** The hosting server stopped admitting it holds this repository. */
	| { kind: "vanished"; did: string };

/** Whether a finding should wake somebody up. */
export function isAlertable(finding: IdentityFinding): boolean {
	return finding.kind === "changed" || finding.kind === "vanished";
}

/**
 * Decide what, if anything, happened to one identity.
 *
 * Pure, so the interesting cases are cheap to enumerate — which matters because the
 * expensive ones to get wrong (an outage read as a disappearance) never occur in a normal
 * run and would otherwise only be exercised by an actual incident.
 *
 * Returns every applicable finding rather than the first: a migration away changes the
 * document *and* removes it from the old server, and reporting only one of those would
 * describe half of what happened.
 */
export function assessIdentity(input: AssessInput): IdentityFinding[] {
	const { did, stored, observed, listed } = input;
	const findings: IdentityFinding[] = [];

	// A server that did not answer says nothing about whether it still holds this. Checked
	// before anything else so that an outage can never contribute a finding.
	if (listed === false && stored !== null) {
		findings.push({ kind: "vanished", did });
	}

	if (observed === null) {
		findings.push({ kind: "unreadable", did });
		return findings;
	}

	if (stored === null || stored.headCid === null) {
		findings.push({ kind: "first-seen", did, headCid: observed.headCid });
		return findings;
	}

	if (stored.headCid !== observed.headCid) {
		findings.push({
			kind: "changed",
			did,
			from: stored.headCid,
			to: observed.headCid,
			handleFrom: stored.handle,
			handleTo: observed.handle,
			endpointFrom: stored.pdsEndpoint,
			endpointTo: observed.pdsEndpoint,
		});
		return findings;
	}

	findings.push({ kind: "unchanged", did });
	return findings;
}

/**
 * Read the newest operation from an identity's public audit log.
 *
 * Returns `null` on any failure rather than throwing, because the caller's correct response
 * to "could not read" is to do nothing and try again — not to treat the identity as
 * changed, and not to abandon the rest of the sweep.
 */
export async function readIdentityHead(
	did: string,
	opts: { directoryUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<ObservedIdentity | null> {
	const base = opts.directoryUrl ?? "https://plc.directory";
	const doFetch = opts.fetchImpl ?? fetch;
	try {
		const res = await doFetch(`${base}/${encodeURIComponent(did)}/log/audit`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const log = (await res.json()) as Array<{
			cid?: string;
			nullified?: boolean;
			operation?: {
				alsoKnownAs?: string[];
				services?: { atproto_pds?: { endpoint?: string } };
			};
		}>;
		// ⚠️ Nullified entries are operations a higher key already clobbered — they are in
		// the log as history and are not the current state. Taking the last entry blindly
		// would read a *recovery* as the newest thing that happened, which is backwards.
		const live = log.filter((e) => !e.nullified);
		const head = live.at(-1);
		if (!head?.cid) return null;
		const aka = head.operation?.alsoKnownAs?.[0] ?? null;
		return {
			headCid: head.cid,
			handle: aka?.startsWith("at://") ? aka.slice("at://".length) : aka,
			pdsEndpoint: head.operation?.services?.atproto_pds?.endpoint ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * Ask a Personal Data Server which repositories it holds.
 *
 * Returns `null` when the server could not be reached, which the caller must keep distinct
 * from an empty list — see `AssessInput.listed`.
 */
export async function listHostedRepos(
	pdsUrl: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<string[] | null> {
	const doFetch = opts.fetchImpl ?? fetch;
	const dids: string[] = [];
	let cursor: string | undefined;
	try {
		// Paginated, because a server with more accounts than one page would otherwise have
		// its tail silently unwatched — which looks exactly like the attack this detects.
		for (let page = 0; page < 100; page++) {
			const url = new URL(`${pdsUrl}/xrpc/com.atproto.sync.listRepos`);
			url.searchParams.set("limit", "1000");
			if (cursor) url.searchParams.set("cursor", cursor);
			const res = await doFetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
			if (!res.ok) return null;
			const body = (await res.json()) as { repos?: Array<{ did?: string }>; cursor?: string };
			for (const r of body.repos ?? []) if (r.did) dids.push(r.did);
			if (!body.cursor || (body.repos ?? []).length === 0) break;
			cursor = body.cursor;
		}
		return dids;
	} catch {
		return null;
	}
}
