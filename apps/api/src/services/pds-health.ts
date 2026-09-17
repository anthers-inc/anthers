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
}

interface Remembered {
	reachable: boolean;
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
		const reachable = await ping(origin, opts.fetchImpl ?? fetch);
		remembered = {
			reachable,
			checkedAt: now,
			downSince: reachable ? null : (remembered?.downSince ?? now),
		};
		byOrigin.set(origin, remembered);
	}

	return {
		reachable: remembered.reachable,
		downSince: remembered.downSince === null ? null : new Date(remembered.downSince).toISOString(),
		statusUrl,
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
