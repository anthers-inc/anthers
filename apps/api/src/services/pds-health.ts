// SPDX-License-Identifier: Apache-2.0
/**
 * Whether the server holding somebody's identity is answering, when Anthers does not run it.
 *
 * ⭐ **Anthers made a third party's server load-bearing for its users, so noticing that server is
 * down is Anthers' job** (Parker, 2026-09-12): *"Being able to quickly let users/creators know
 * that their external PDS is having issues, what we know about when it might be back, and where
 * they can check the outage for themselves will buy us a lot of good will."* A creator on
 * bsky.social whose server is down sees every release succeed and every listing quietly queue
 * and retry, which is the right behavior and, told to nobody, the wrong experience.
 *
 * 🚨 **This informs and never blocks.** Publishing is a job rather than part of a release
 * precisely so a release never depends on the uptime of a machine the creator may not run — the
 * wiki's *Where the Data Is Canonical*. Nothing here is read by a refusal.
 *
 * ⚠️ **Our own pings, not a status feed.** A server's `/xrpc/_health` is unauthenticated and
 * cheap, answers for any server rather than Bluesky's alone, and says whether *this* server is
 * up rather than whether an incident has been posted. Bluesky's status page is linked for the
 * servers it runs, as the place somebody can see what is known about when it will be back.
 *
 * The same read asks whether the server serves its `/account` page, because Settings links
 * there for an identity Anthers does not host and a link is a claim that a page exists.
 */

/** How long one server's answer stands, per process. */
export const PDS_HEALTH_TTL_MS = 5 * 60 * 1000;

/** How long a ping waits before calling a server down. */
const PING_TIMEOUT_MS = 5000;

/** Bluesky's own status page, for the servers Bluesky runs. */
export const BLUESKY_STATUS_URL = "https://status.bsky.app";

export interface PdsHealth {
	/** False when the server did not answer, or answered with an error. */
	reachable: boolean;
	/** When this process first saw it down, for as long as it stays down. */
	downSince: string | null;
	/** Where to see what is known about an outage, or null when we know of nowhere. */
	statusUrl: string | null;
	/**
	 * Whether the server answers `/account`, the account page the reference PDS ships.
	 *
	 * ⚠️ **Asked rather than assumed, because a link is a claim that there is a page.** Every
	 * PDS built on the reference server since v0.4.5006 answers it, and one still on an older
	 * release does not, so the only way to know which a stranger's server is is to ask it.
	 */
	accountPage: boolean;
}

interface Remembered {
	reachable: boolean;
	accountPage: boolean;
	checkedAt: number;
	downSince: number | null;
}

const byOrigin = new Map<string, Remembered>();

/**
 * The status page for a server, when we know one.
 *
 * Bluesky runs `bsky.social` on hosts under `bsky.network`, so an identity's server URL names one
 * of those rather than `bsky.social` itself.
 */
export function statusPageFor(pdsUrl: string): string | null {
	try {
		const host = new URL(pdsUrl).hostname;
		return host === "bsky.social" || host.endsWith(".bsky.network") ? BLUESKY_STATUS_URL : null;
	} catch {
		return null;
	}
}

/**
 * Ask whether an identity's server is up, at most once per {@link PDS_HEALTH_TTL_MS} per server.
 *
 * ⚠️ **Per server, not per person.** Thousands of creators share one bsky.social host, and an
 * outage is a fact about the host, so the answer is remembered by origin. The memory is per
 * process, so another instance may ask again sooner, which costs one small request.
 */
export async function pdsHealth(
	pdsUrl: string,
	opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<PdsHealth | null> {
	let origin: string;
	try {
		origin = new URL(pdsUrl).origin;
	} catch {
		return null;
	}
	const now = opts.now ?? Date.now();
	const statusUrl = statusPageFor(pdsUrl);

	let remembered = byOrigin.get(origin);
	if (!remembered || now - remembered.checkedAt >= PDS_HEALTH_TTL_MS) {
		const [reachable, accountPage] = await Promise.all([
			ping(origin, opts.fetchImpl ?? fetch),
			answersAccountPage(origin, opts.fetchImpl ?? fetch),
		]);
		remembered = {
			reachable,
			accountPage,
			checkedAt: now,
			downSince: reachable ? null : (remembered?.downSince ?? now),
		};
		byOrigin.set(origin, remembered);
	}

	return {
		reachable: remembered.reachable,
		downSince: remembered.downSince === null ? null : new Date(remembered.downSince).toISOString(),
		statusUrl,
		accountPage: remembered.accountPage,
	};
}

async function ping(origin: string, doFetch: typeof fetch): Promise<boolean> {
	try {
		const res = await doFetch(`${origin}/xrpc/_health`, {
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Whether a server serves the account page, asked of the page itself.
 *
 * ⚠️ **A redirect counts, and the redirect is not followed.** A server may send `/account` to a
 * sign-in page, or to its own `/` , and either way the page exists; following it, though, would
 * let a DID document point this process at a host it should not reach, which is why the answer
 * is read off the first response.
 */
async function answersAccountPage(origin: string, doFetch: typeof fetch): Promise<boolean> {
	try {
		const res = await doFetch(`${origin}/account`, {
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
			redirect: "manual",
		});
		// The body is worth nothing here, and leaving it unread holds the connection.
		await res.body?.cancel();
		return res.status >= 200 && res.status < 400;
	} catch {
		return false;
	}
}
