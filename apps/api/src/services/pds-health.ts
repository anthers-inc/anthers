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
 * ⚠️ **Our own pings, not a status feed.** The probe asks
 * `com.atproto.server.describeServer`, a door every PDS owes its own Lexicon and the same one
 * Anthers writes records through, so a server that answers it is a server this deployment can
 * publish to; the reference server's `/xrpc/_health` was the older door and is a diagnostic one
 * rather than an API each host has to serve. Bluesky's status page is linked for the servers it
 * runs, as the place somebody can see what is known about when it will be back.
 *
 * The same read asks whether the server serves its `/account` page, because Settings links
 * there for an identity Anthers does not host and a link is a claim that a page exists.
 */

/** How long one server's answer stands, per process. */
export const PDS_HEALTH_TTL_MS = 5 * 60 * 1000;

/** How long one attempt waits before it is abandoned. */
const PING_TIMEOUT_MS = 5000;

/**
 * The unauthenticated XRPC door the probe asks.
 *
 * ⚠️ **A door the server's own Lexicon guarantees, not a diagnostic endpoint.** The probe read
 * `/xrpc/_health` until 2026-10-23, which is a convenience the reference server happens to
 * expose and no host is obliged to — and a false "down" is the expensive direction here: it
 * tells a creator somebody else's server is broken, in the middle of releasing a Work.
 * `describeServer` is required of every PDS and is the door a record write goes through.
 */
const PROBE_PATH = "/xrpc/com.atproto.server.describeServer";

/** Bluesky's own status page, for the servers Bluesky runs. */
export const BLUESKY_STATUS_URL = "https://status.bsky.app";

export interface PdsHealth {
	/**
	 * False only when the server did not answer at all, or answered with a 5xx — after a retry.
	 * A 4xx is a server that answered and refused this ask, which is a server that is up.
	 */
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
		const [health, accountPage] = await Promise.all([
			answeringProbe(origin, opts.fetchImpl ?? fetch),
			answersAccountPage(origin, opts.fetchImpl ?? fetch),
		]);
		if (!health.ok) {
			// 🚨 **A down report has to leave a trace**, because there is nothing else to read
			// afterwards: the notice is a sentence about somebody else's server, and a creator
			// asking "is that true?" could only be answered by pinging it again (2026-10-23).
			console.warn(
				`[pds-health] ${origin} is not answering ${PROBE_PATH} (${health.detail}) — ` +
					`reporting it down for the next ${Math.round(PDS_HEALTH_TTL_MS / 60_000)} minutes`,
			);
		}
		remembered = {
			reachable: health.ok,
			accountPage,
			checkedAt: now,
			downSince: health.ok ? null : (remembered?.downSince ?? now),
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

/** One attempt's answer: whether the server answered, and what it said for the log line. */
interface Probe {
	ok: boolean;
	detail: string;
}

/**
 * Ask the probe door, once.
 *
 * ⚠️ **Any answer below 500 means the server is answering.** A 4xx is a live server refusing
 * this particular ask, not a server that is missing, and counting it as down is how a working
 * PDS produced a false outage notice on 2026-10-23. A 5xx is a server that answered and could
 * not serve, which is down for the purpose this answers.
 */
async function probe(origin: string, doFetch: typeof fetch): Promise<Probe> {
	try {
		const res = await doFetch(`${origin}${PROBE_PATH}`, {
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
		});
		// The body is worth nothing here, and leaving it unread holds the connection.
		await res.body?.cancel();
		return res.status < 500
			? { ok: true, detail: String(res.status) }
			: { ok: false, detail: `answered ${res.status}` };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : "did not answer" };
	}
}

/**
 * The server's answer, with one retry before a failure is believed.
 *
 * ⚠️ **A single refused or reset connection is not an outage**, and the memory below makes the
 * wrong answer stick for five minutes. A second attempt costs one small request and keeps one
 * dropped connection from telling a creator their identity's server is broken.
 */
async function answeringProbe(origin: string, doFetch: typeof fetch): Promise<Probe> {
	const first = await probe(origin, doFetch);
	return first.ok ? first : probe(origin, doFetch);
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
