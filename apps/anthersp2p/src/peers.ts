// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The client half of peer discovery — announcing where you are, and finding where others
 * are (45.01 § 3).
 *
 * Both halves live together because they are two ends of one hub endpoint pair, and because
 * a single `anthersp2p` process is often both: a box that seeds a Work is usually a box that
 * pulled it first.
 *
 * ── Announcing is a lease you hold, not a registration you make ─────────────────────
 *
 * The hub publishes a peer for a few minutes at a time and a seeder re-announces to keep it
 * listed. The renewal interval comes from the hub's own `leaseSeconds` rather than a
 * constant here — a client that hard-codes its idea of the lease keeps working right up
 * until the hub changes it, and then fails as a slow disappearance nobody connects to a
 * deploy.
 *
 * ── A failed announcement is not a failed seed ──────────────────────────────────────
 *
 * If the hub refuses — the host is unreachable from outside, the URL is http, the account is
 * already advertising its limit — the seeder keeps serving. Discovery is how peers are
 * *found*; a peer whose URL someone passes by hand works exactly as well. So announcing
 * warns and continues rather than exiting, which is also what makes `seed` usable from a
 * laptop that cannot accept inbound connections at all.
 */

export interface AnnounceOptions {
	baseUrl: string;
	token: string;
	workId: string;
	assetId: number;
	/** The origin OTHER hosts can reach this seeder at. Not the listen address. */
	publicUrl: string;
	fetchImpl?: typeof fetch;
	onLog?: (line: string) => void;
}

export interface AnnounceOutcome {
	ok: boolean;
	/** Seconds the hub will keep this listed. Absent when the announcement was refused. */
	leaseSeconds?: number;
	/** The hub's own words about a refusal — written for whoever runs the host. */
	message?: string;
}

function announceUrl(o: Pick<AnnounceOptions, "baseUrl" | "workId" | "assetId">): string {
	return `${o.baseUrl}/api/p2p/works/${o.workId}/assets/${o.assetId}/announce`;
}

/** Tell the hub where this seeder is. One attempt; the caller decides about retrying. */
export async function announceOnce(opts: AnnounceOptions): Promise<AnnounceOutcome> {
	const doFetch = opts.fetchImpl ?? fetch;
	try {
		const res = await doFetch(announceUrl(opts), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${opts.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ url: opts.publicUrl }),
		});
		const body = (await res.json().catch(() => ({}))) as {
			leaseSeconds?: number;
			error?: string;
			renewed?: boolean;
		};
		if (!res.ok) return { ok: false, message: body.error ?? `HTTP ${res.status}` };
		return { ok: true, leaseSeconds: body.leaseSeconds };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

/** Ask the hub to stop listing this seeder. Best-effort: the lease lapses anyway. */
export async function withdrawOnce(opts: AnnounceOptions): Promise<void> {
	const doFetch = opts.fetchImpl ?? fetch;
	try {
		await doFetch(announceUrl(opts), {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${opts.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ url: opts.publicUrl }),
		});
	} catch {
		// A seeder that cannot reach the hub on shutdown has nothing useful to do about it.
		// The lease is short precisely so that this path is optional rather than load-bearing.
	}
}

export interface AnnouncementHandle {
	/** Whether the first announcement was accepted. Later renewals may still fail. */
	listed: boolean;
	stop(): Promise<void>;
}

/**
 * Announce, then keep the lease alive until stopped.
 *
 * Renews at **half** the lease, so one lost request is survivable — at three-quarters a
 * single failed renewal would leave a gap where the seeder is serving and unlisted, and the
 * whole reason to hold a lease rather than a registration is that gaps close themselves.
 */
export async function startAnnouncing(opts: AnnounceOptions): Promise<AnnouncementHandle> {
	const log = opts.onLog ?? (() => {});
	const first = await announceOnce(opts);

	if (first.ok) {
		log(`  announced to the hub as ${opts.publicUrl} — downloaders can find this seeder`);
	} else {
		// Deliberately a warning. See the header: unlisted is a working seeder that is harder
		// to reach, not a broken one.
		log(`  ⚠ the hub would not list this seeder: ${first.message}`);
		log("    it will keep serving; downloaders can still reach it with `pull --peer`");
	}

	const leaseSeconds = first.leaseSeconds ?? 600;
	const timer = setInterval(
		() => {
			void announceOnce(opts).then((r) => {
				if (!r.ok) log(`  ⚠ could not renew the hub listing: ${r.message}`);
			});
		},
		Math.max(30, Math.floor(leaseSeconds / 2)) * 1000,
	);
	// Do not hold the process open on our own account: the seeder's HTTP server is what
	// keeps it alive, and a renewal timer that outlived it would be a process that refuses
	// to exit for no reason anyone could see.
	timer.unref?.();

	return {
		listed: first.ok,
		async stop() {
			clearInterval(timer);
			if (first.ok) await withdrawOnce(opts);
		},
	};
}

/**
 * Ask the hub which peers are serving an asset.
 *
 * Returns an empty list on any failure, and that is the whole error policy: the hub is
 * always in the swarm as the floor (45.01 § 3), so "no peers" is a supported, correct
 * outcome rather than a degraded one. A downloader that treated a discovery failure as
 * fatal would turn an optimization into a dependency.
 */
export async function discoverPeers(opts: {
	baseUrl: string;
	token: string;
	workId: string;
	assetId: number;
	fetchImpl?: typeof fetch;
}): Promise<string[]> {
	const doFetch = opts.fetchImpl ?? fetch;
	try {
		const res = await doFetch(
			`${opts.baseUrl}/api/p2p/works/${opts.workId}/assets/${opts.assetId}/peers`,
			{ headers: { Authorization: `Bearer ${opts.token}` } },
		);
		if (!res.ok) return [];
		const body = (await res.json()) as { peers?: unknown };
		if (!Array.isArray(body.peers)) return [];
		return body.peers.filter((p): p is string => typeof p === "string" && p.length > 0);
	} catch {
		return [];
	}
}
