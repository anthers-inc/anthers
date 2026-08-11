// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Peer presence for the P2P signaling relay — who is online, for which asset, and how to
 * reach them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * 🚨 REPLACE THIS BEFORE RAISING `instance_count` ABOVE 1 ON THE `api` COMPONENT.
 *
 * The failure is silent, and that is the whole reason this file is an interface with one
 * implementation behind it rather than a Map in `signaling.ts`.
 *
 * At `instance_count: 2` the load balancer puts peer A on instance 1 and peer B on
 * instance 2. B asks "who else has asset X?", instance 2 consults *its own* Map, finds
 * nobody, and answers honestly-but-wrongly: there are no peers. Both peers are online,
 * both hold the bytes, and they never meet. The swarm fragments into one swarm per
 * instance and every download quietly falls back to hub-served chunks — which work
 * perfectly. Nothing errors. Nothing logs. The only symptom is that P2P stops saving
 * bandwidth, visible on a cost graph weeks later rather than in a stack trace.
 *
 * The replacement is Postgres presence rows plus `LISTEN`/`NOTIFY` for the cross-instance
 * hop: `peersFor` becomes a query, `send` becomes a NOTIFY that the instance holding the
 * socket picks up. Everything above this interface stays as it is.
 *
 * `make spec-diff` warns when the live spec's api `instance_count` is above 1, so the
 * trigger fires at the moment someone scales rather than depending on them having read
 * this comment. Both belong here: the comment explains, the tool interrupts.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Why in-memory at all, given that hazard: a WebSocket is an object owned by the process
 * that accepted it. A row in Postgres can record that a peer is online; it cannot hold the
 * socket. So *something* per-process is unavoidable — the question is only whether the
 * lookup that finds a peer is per-process too, and today it is because there is exactly
 * one process.
 *
 * What is deliberately NOT in here: the token. A peer's authorization is verified once, at
 * the socket's first frame (45.05), and what survives is the fact of it — the asset it was
 * scoped to and the moment it lapses. Keeping the token would invite a second verification
 * path, and two verifiers of one credential eventually disagree.
 */

/** Where a message to a peer actually goes. Abstracted so the registry never sees a Bun type. */
export interface PeerSink {
	send(data: string): void;
	close(code: number, reason: string): void;
}

export interface PeerRecord {
	/** Hub-assigned. Never client-supplied — see `signaling.ts` for why that matters. */
	peerId: string;
	/** The asset this peer's token was scoped to. The swarm boundary. */
	assetId: number;
	/** The Work the asset belongs to. Carried for logging and bandwidth accounting. */
	workId: number;
	/**
	 * The user the hub vouched for. Held for the per-user socket cap and for nothing else —
	 * in particular it is never sent to another peer. A peer learns the other side's IP
	 * from ICE regardless (see `signaling.ts` § What peers learn about each other), but
	 * that is WebRTC's disclosure, and there is no reason for the relay to add an account
	 * identity on top of it.
	 */
	userId: number;
	/** Unix seconds — when the token that vouched for this peer lapses. */
	expiresAt: number;
	/** Whether this peer has announced it can serve chunks, as opposed to only pulling. */
	serving: boolean;
}

/**
 * The seam. Discovery (`peersFor`) and delivery (`send`) are the two operations that
 * become cross-instance queries the day this stops being one process; everything else is
 * bookkeeping that would move with them.
 */
export interface PeerRegistry {
	register(record: PeerRecord, sink: PeerSink): void;
	unregister(peerId: string): PeerRecord | null;
	get(peerId: string): PeerRecord | null;
	/** Peers that have announced they can serve `assetId`, excluding the asker. */
	peersFor(assetId: number, opts: { excludePeerId: string; limit: number }): PeerRecord[];
	/** Everyone registered against `assetId`, serving or not — the notification audience. */
	membersOf(assetId: number, opts: { excludePeerId: string; limit: number }): PeerRecord[];
	/** Deliver a message. False means "not on this instance", which today means "gone". */
	send(peerId: string, message: unknown): boolean;
	setServing(peerId: string, serving: boolean): void;
	/** Extend a peer's vouch after it presents a fresh token. */
	refresh(peerId: string, expiresAt: number): void;
	countForUser(userId: number): number;
	size(): number;
}

interface Entry {
	record: PeerRecord;
	sink: PeerSink;
}

/**
 * The single-process implementation.
 *
 * Three indexes over one set of entries: by peer id (for `send` and `get`), by asset (for
 * discovery), and by user (for the per-user socket cap). All three are maintained together
 * in `register`/`unregister`, which is the only reason to keep them private rather than
 * exposing the Maps.
 */
export class InMemoryPeerRegistry implements PeerRegistry {
	private readonly byId = new Map<string, Entry>();
	private readonly byAsset = new Map<number, Set<string>>();
	private readonly byUser = new Map<number, Set<string>>();

	register(record: PeerRecord, sink: PeerSink): void {
		this.unregister(record.peerId);
		this.byId.set(record.peerId, { record, sink });
		addTo(this.byAsset, record.assetId, record.peerId);
		addTo(this.byUser, record.userId, record.peerId);
	}

	unregister(peerId: string): PeerRecord | null {
		const entry = this.byId.get(peerId);
		if (!entry) return null;
		this.byId.delete(peerId);
		removeFrom(this.byAsset, entry.record.assetId, peerId);
		removeFrom(this.byUser, entry.record.userId, peerId);
		return entry.record;
	}

	get(peerId: string): PeerRecord | null {
		return this.byId.get(peerId)?.record ?? null;
	}

	peersFor(assetId: number, opts: { excludePeerId: string; limit: number }): PeerRecord[] {
		return this.scan(assetId, opts, (r) => r.serving);
	}

	membersOf(assetId: number, opts: { excludePeerId: string; limit: number }): PeerRecord[] {
		return this.scan(assetId, opts, () => true);
	}

	send(peerId: string, message: unknown): boolean {
		const entry = this.byId.get(peerId);
		if (!entry) return false;
		try {
			entry.sink.send(JSON.stringify(message));
			return true;
		} catch {
			// A socket that has gone away mid-iteration. Drop it rather than letting one
			// dead peer abort a fan-out to healthy ones.
			this.unregister(peerId);
			return false;
		}
	}

	setServing(peerId: string, serving: boolean): void {
		const entry = this.byId.get(peerId);
		if (entry) entry.record.serving = serving;
	}

	refresh(peerId: string, expiresAt: number): void {
		const entry = this.byId.get(peerId);
		if (entry) entry.record.expiresAt = expiresAt;
	}

	countForUser(userId: number): number {
		return this.byUser.get(userId)?.size ?? 0;
	}

	size(): number {
		return this.byId.size;
	}

	/**
	 * The size of each index, for asking "is the relay leaking?" and getting an answer.
	 *
	 * This exists because a leak in the two secondary indexes is invisible from every other
	 * method here: an asset whose last peer has gone returns an empty peer list and a
	 * `size()` of zero whether its `Set` was deleted or left behind empty forever. That is
	 * not hypothetical — the cleanup in `removeFrom` was written first, and sabotaging it
	 * broke nothing, because the test asserting it could only see through the accessors
	 * that agree either way. A bound you cannot observe is a bound you cannot keep.
	 */
	indexSizes(): { peers: number; assets: number; users: number } {
		return { peers: this.byId.size, assets: this.byAsset.size, users: this.byUser.size };
	}

	/**
	 * The one place expired peers are dropped, and it is deliberately lazy rather than a
	 * background timer.
	 *
	 * A peer whose token has lapsed is out of the swarm by 45.05's definition, so it must
	 * not be introduced to anyone. But nothing bad happens while it sits in a Map unread —
	 * the socket's own message handler closes it on its next frame, and `close` unregisters
	 * it. Sweeping here, on the read that would otherwise return it, covers the one case
	 * that matters (a silent peer that will never send another frame) without a timer that
	 * every test process would then have to unref.
	 */
	private scan(
		assetId: number,
		opts: { excludePeerId: string; limit: number },
		accept: (record: PeerRecord) => boolean,
	): PeerRecord[] {
		const ids = this.byAsset.get(assetId);
		if (!ids) return [];
		const now = Math.floor(Date.now() / 1000);
		const out: PeerRecord[] = [];
		const expired: string[] = [];
		for (const id of ids) {
			const entry = this.byId.get(id);
			if (!entry) continue;
			if (entry.record.expiresAt <= now) {
				expired.push(id);
				continue;
			}
			if (id === opts.excludePeerId) continue;
			if (!accept(entry.record)) continue;
			out.push(entry.record);
			if (out.length >= opts.limit) break;
		}
		for (const id of expired) {
			this.byId.get(id)?.sink.close(4003, "token_expired");
			this.unregister(id);
		}
		return out;
	}
}

function addTo<K>(index: Map<K, Set<string>>, key: K, peerId: string): void {
	const existing = index.get(key);
	if (existing) existing.add(peerId);
	else index.set(key, new Set([peerId]));
}

function removeFrom<K>(index: Map<K, Set<string>>, key: K, peerId: string): void {
	const set = index.get(key);
	if (!set) return;
	set.delete(peerId);
	// Drop the empty Set rather than leaving it: an asset that is downloaded once and never
	// again would otherwise leave a permanent entry, and "bounded" has to mean bounded by
	// the number of peers ONLINE, not by the number of assets ever requested.
	if (set.size === 0) index.delete(key);
}
