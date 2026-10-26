// SPDX-License-Identifier: Apache-2.0
/**
 * The buyer's basket — which Works they mean to buy on one charge.
 *
 * 🚨 **Server-side, scoped to the account** (Parker, 2026-10-03, live testing: the old
 * `localStorage` basket followed the browser, so a second account signing in inherited the
 * first account's basket). A signed-in buyer's basket lives in `basket_items` and is read
 * and written through the authenticated API; the browser holds nothing but this module's
 * cache of what the server answered — a module store rather than per-component state, for
 * the same reasons `lib/library.ts` is one: the badge, the page and the buy doors are
 * separate subscribers of one truth, and an add on one surface must move the badge on
 * another within the tab.
 *
 * ⚠️ **An anonymous visitor still keeps a scratchpad in `localStorage`** — a buyer who
 * fills a basket before signing in must not find it empty after. That scratch is the only
 * browser-side basket, and it is transient by contract: at sign-in it is merged into the
 * account's basket through the server's own `add` logic (the one-creator rule, the item
 * cap and the existence check all fire — nothing bypassed) and then cleared. Nothing
 * signed-in ever reads it, so a second account starts empty, which is the whole point of
 * the move. Cross-tab sync is the one thing scratch mode keeps and server mode does not:
 * the truth is per-account now, and a stale second tab heals on its next read.
 *
 * The one-creator rule is the SERVER's in server mode — `add` POSTs and the server
 * replaces on a creator clash, answering with the dropped creator's handle so the surface
 * can say so — and this hook's in scratch mode, exactly as it always was. The two modes
 * answer identically to the buyer because both mean "my most recent intent wins".
 *
 * Everything is re-resolved server-side at quote and checkout exactly as before; the
 * basket — wherever it lives — is intent, never prices.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** The scratchpad's localStorage key. An account basket never lives here. */
const KEY = "anthers_basket";
/** Bumped when the stored shape changes, so an old basket is dropped rather than parsed. */
const VERSION = 1;

/**
 * A Work line — the only kind the anonymous scratchpad ever holds (a visitor picking a
 * Badge rung is detoured through sign-in/up before anything is held, so no scratch
 * Badge exists), and the stored shape.
 */
export interface BasketWorkItem {
	kind: "work";
	workId: number;
	slug: string;
	title: string;
	price: string;
	creatorHandle: string;
	thumbnail?: string | null;
	/**
	 * How many of a physical good this line means to buy, and the values chosen from its
	 * listing. A digital Work carries neither: it is owned once, and the server refuses a
	 * count on a kind that cannot carry one.
	 */
	quantity?: number;
	options?: Array<{ name: string; label: string }> | null;
}

/**
 * A Badge line — the rung the buyer picked, joined from the account basket only. Its
 * `price` is the FIRST transaction's figure (a delta when the buyer upgrades from a
 * lower rung) and `recurring` is the rung's monthly price the line begins — together,
 * because an upgrade line reads as the upgrade it is rather than a discount.
 */
export interface BasketBadgeItem {
	kind: "badge";
	badgeId: number;
	title: string;
	price: string;
	/** The rung's monthly threshold, always present for a Badge line. */
	recurring: string;
	creatorHandle: string;
}

export type BasketItem = BasketWorkItem | BasketBadgeItem;

/**
 * The basket's CONTENT identity — every line's id, kind-tagged, sorted, plus a physical
 * line's count and chosen values.
 *
 * 🚨 **The picks are part of the identity.** This string decides when the embedded checkout
 * re-posts for a session (`BasketCheckout`'s remount guard). A buyer who switches a size
 * or raises a count has a different basket and must get a session built for it, not the
 * one built for what they chose a minute ago. The **server** keeps its own copy of this
 * question (`basketPicksKey` in `routes/payments.ts`, compared against the session's
 * metadata) and the two deliberately do not share a format — each only has to be stable
 * for its own side.
 */
export function basketContentKey(items: BasketItem[]): string {
	return items
		.map((i) => {
			if (i.kind === "badge") return `b${i.badgeId}`;
			const quantity = i.quantity ?? 1;
			const picks = (i.options ?? [])
				.map((option) => `${option.name}=${option.label}`)
				.sort()
				.join("&");
			return quantity === 1 && !picks ? `w${i.workId}` : `w${i.workId}q${quantity}[${picks}]`;
		})
		.sort()
		.join(",");
}

interface StoredBasket {
	version: number;
	items: BasketWorkItem[];
}

function read(): BasketWorkItem[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as StoredBasket;
		if (parsed?.version !== VERSION || !Array.isArray(parsed.items)) return [];
		// Version 1 stored only Works; the type is the contract.
		return parsed.items;
	} catch {
		// A corrupt basket is an empty basket. Never throw out of storage access —
		// Safari's private mode throws on `localStorage` entirely.
		return [];
	}
}

function write(items: BasketWorkItem[]) {
	try {
		localStorage.setItem(KEY, JSON.stringify({ version: VERSION, items } satisfies StoredBasket));
	} catch {
		// Storage full or blocked: the basket stays in memory for this page's lifetime.
	}
	// Same-tab listeners. The native `storage` event fires only in OTHER tabs, so
	// without this the header count wouldn't move on the tab doing the adding.
	window.dispatchEvent(new CustomEvent(EVENT));
}

const EVENT = "anthers:basket";
/**
 * The server's answer for `/basket` reads — cached here so every subscriber shares one
 * fetch, and discriminated: the server resolves both kinds live (price, handle, only
 * what a checkout could accept — a Badge line carries the rung's monthly price beside
 * the first transaction's).
 */
type ServerItem =
	| {
			kind: "work";
			workId: number;
			slug: string;
			title: string | null;
			price: string;
			creatorHandle: string;
			thumbnail: string | null;
			quantity?: number;
			options?: Array<{ name: string; label: string }> | null;
			shipping?: string;
	  }
	| {
			kind: "badge";
			badgeId: number;
			title: string | null;
			price: string;
			recurring: string | null;
			creatorHandle: string;
	  };
interface ServerBasket {
	items: ServerItem[];
}

// ── The server-backed store (module-level, like `lib/library.ts`) ────────────
//
// A module store rather than per-component state, for the reasons the Library uses one: a
// page can hold many subscribers (badge, page, buttons) and none should refetch; and a
// add from one surface must move the badge on another, within one tab. Cross-TAB sync is
// the one thing this mode does not do that scratch mode did — a second tab cannot be told
// by an event, because the truth is on the server and each tab reconciles on its own
// navigation. The badge on a stale tab heals on next read, which is the same tolerance
// every other server-scoped surface here accepts.

let serverCurrent: ServerBasket | null = null;
const serverListeners = new Set<(b: ServerBasket | null) => void>();

function publishServer(next: ServerBasket | null) {
	serverCurrent = next;
	for (const fn of serverListeners) fn(next);
}

/** Ask the server for the account's basket, and publish it. */
async function loadServer(): Promise<void> {
	try {
		const res = await client.api.payments.basket.$get();
		if (!res.ok) {
			publishServer(null);
			return;
		}
		const body = (await res.json()) as unknown as { items: ServerItem[] };
		publishServer({ items: body.items });
	} catch {
		publishServer(null);
	}
}

/**
 * Refresh the server basket NOW, deduplicated — every caller in one tick shares the fetch,
 * the way `refreshLibrary` works.
 */
export function refreshServerBasket(): void {
	if (loadInFlight) return;
	loadInFlight = loadServer().finally(() => {
		loadInFlight = null;
	});
}

let loadInFlight: Promise<void> | null = null;

/**
 * Merge the anonymous scratch basket into the account's basket and clear the scratchpad.
 *
 * Called by the auth flows at the moment a session becomes real (`LoginPage`'s code
 * verify, the ATProto callback, the signup finish — each just before `refreshUser`).
 * A failed merge KEEPS the scratch: the next sign-in path will try again, and losing a
 * buyer's filled basket to a network blip is the one failure worse than not merging.
 * The scratch is cleared only on a good answer, after which the browser holds nothing —
 * which is the design's whole point.
 */
export async function mergeIntoServerBasket(): Promise<void> {
	const scratch = read();
	if (scratch.length > 0) {
		const res = await client.api.auth.basket.merge.$post({
			json: { items: scratch.map((i) => ({ workId: i.workId })) },
		});
		// A refusal keeps the scratch for a later attempt. The account basket is untouched
		// either way — the server merges item-by-item through its own `add`.
		if (!res.ok) return;
	}
	write([]);
	// The account basket may have grown; the fetch happens when the hook mounts or the
	// caller refreshes — here we invalidate so the next read is fresh.
	publishServer(null);
}

/**
 * Read and mutate the basket, in two modes.
 *
 * **Authenticated → server-backed.** `items` is what the server says the account holds,
 * resolved live (price, handle, and only what a checkout would accept). Mutations are
 * optimistic: the cache moves at once, the server's answer replaces it, and a refusal
 * rolls the cache back and names why.
 *
 * **Anonymous → the localStorage scratchpad**, unchanged from the client-side design:
 * cross-tab through the `storage` event, same-tab through a custom event, and no write
 * is confirmed by anyone.
 *
 * Both modes expose the same verbs and the same item shape, so the page, badge and buy
 * doors never branch on the mode. (`add`'s refusal shape differs between modes only in
 * that server mode can actually refuse — a full basket, a vanished Work.)
 */
export function useBasket(): BasketApi {
	const { user } = useAuth();
	const authenticated = user != null;

	const [scratchItems, setScratchItems] = useState<BasketWorkItem[]>([]);
	const [serverItems, setServerItems] = useState<ServerBasket | null>(serverCurrent);

	// Scratch mode's subscriptions: unchanged from the client-side design. The effect
	// re-subscribes on a mode change only: `authenticated` flipping is what moves the
	// hook between the two baskets, and that re-run is the transition's own wiring
	// (Biome reads only the ref inside; the dependency INTENDS the flip, and the
	// exhaustive-deps rule is satisfied by naming what the effect genuinely answers to).
	useEffect(() => {
		if (authenticated) return;
		setScratchItems(read());
		const sync = () => {
			setScratchItems(read());
		};
		window.addEventListener("storage", sync);
		window.addEventListener(EVENT, sync);
		return () => {
			window.removeEventListener("storage", sync);
			window.removeEventListener(EVENT, sync);
		};
	}, [authenticated]);

	// Server mode's subscriptions: one fetch per mount-of-first-subscriber, then event-sync.
	useEffect(() => {
		if (!authenticated) return;
		serverListeners.add(setServerItems);
		// A cache the auth flow deliberately invalidated (a just-completed merge, a fresh
		// sign-in) refetches; a live one is used as-is.
		if (serverCurrent) setServerItems(serverCurrent);
		else refreshServerBasket();
		return () => {
			serverListeners.delete(setServerItems);
		};
	}, [authenticated]);

	// Signing out ends this tab's knowledge of the account's basket. Dropping the module
	// cache is what stops the NEXT account signing in on this tab from rendering the last
	// one's basket until its own fetch lands — the cross-account leak the server-side move
	// exists to prevent, still reachable inside one SPA session without a reload. The
	// sign-in flows also invalidate on their way in (`mergeIntoServerBasket`), so this is
	// the half that does not depend on the sign-out path calling into the basket at all.
	useEffect(() => {
		if (authenticated) return;
		if (serverCurrent) publishServer(null);
	}, [authenticated]);

	if (authenticated) {
		// Read through the subscription state so a publish re-renders; the verbs below
		// read the same module store, so the render and the verbs cannot disagree.
		const items: BasketItem[] = (serverItems?.items ?? []).map((i) =>
			i.kind === "badge"
				? {
						kind: "badge" as const,
						badgeId: i.badgeId,
						title: i.title ?? "A Badge",
						price: i.price,
						recurring: i.recurring ?? i.price,
						creatorHandle: i.creatorHandle,
					}
				: {
						kind: "work" as const,
						workId: i.workId,
						slug: i.slug,
						title: i.title ?? "Untitled",
						price: i.price,
						creatorHandle: i.creatorHandle,
						thumbnail: i.thumbnail,
						quantity: i.quantity ?? 1,
						options: i.options ?? null,
					},
		);
		return {
			items,
			count: items.length,
			add: SERVER_API.add,
			remove: SERVER_API.remove,
			update: SERVER_API.update,
			clear: SERVER_API.clear,
			has: (workId: number) => items.some((i) => i.kind === "work" && i.workId === workId),
			hasBadge: (badgeId: number) => items.some((i) => i.kind === "badge" && i.badgeId === badgeId),
		} satisfies BasketApi;
	}
	return scratchApi(scratchItems);
}

/** The verbs over the server-backed store. Stable identities at module scope. */
const SERVER_API = {
	async add(item: BasketItem) {
		// A Badge add skips the optimistic half on purpose: the first transaction's price
		// is the server's resolution (a delta, known nowhere on the client), and the POST
		// answers with the resolved basket anyway — showing a guessed price for the half
		// second the POST takes would be a wrong number, which is worse than a spinner.
		if (item.kind === "badge") {
			try {
				const res = await client.api.payments.basket.items.$post({
					json: { badgeId: item.badgeId },
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					return { ok: false as const, error: body?.error ?? "Couldn't add to your basket." };
				}
				const body = (await res.json()) as unknown as { items: ServerItem[] };
				publishServer({ items: body.items });
				return { ok: true as const };
			} catch {
				return { ok: false as const, error: "Couldn't add to your basket." };
			}
		}
		// Optimistic: show the Work in the basket now, reconcile on the answer.
		const prev = serverCurrent;
		publishServer({
			items: [
				...(prev?.items ?? []).filter((i) => !(i.kind === "work" && i.workId === item.workId)),
				{
					kind: "work" as const,
					workId: item.workId,
					slug: item.slug,
					title: item.title,
					price: item.price,
					creatorHandle: item.creatorHandle,
					thumbnail: item.thumbnail ?? null,
					quantity: item.quantity ?? 1,
					options: item.options ?? null,
				},
			],
		});
		try {
			const res = await client.api.payments.basket.items.$post({
				json: {
					workId: item.workId,
					...(item.quantity != null ? { quantity: item.quantity } : {}),
					...(item.options ? { options: item.options } : {}),
				},
			});
			if (!res.ok) {
				// Refused — put the cache back and say so.
				publishServer(prev);
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				return { ok: false as const, error: body?.error ?? "Couldn't add to your basket." };
			}
			const body = (await res.json()) as unknown as { items: ServerItem[] };
			publishServer({ items: body.items });
			return { ok: true as const };
		} catch {
			publishServer(prev);
			return { ok: false as const, error: "Couldn't add to your basket." };
		}
	},
	async update(item: {
		workId: number;
		quantity?: number;
		options?: Array<{ name: string; label: string }>;
	}) {
		const prev = serverCurrent;
		// Optimistic, like the add: the stepper moves at once and the server's answer
		// replaces the cache. A refusal (a count past the shelf) rolls back and says why,
		// because a quantity that quietly springs back is worse than one that explains.
		if (prev)
			publishServer({
				items: prev.items.map((i) =>
					i.kind === "work" && i.workId === item.workId
						? {
								...i,
								...(item.quantity != null ? { quantity: item.quantity } : {}),
								...(item.options !== undefined ? { options: item.options } : {}),
							}
						: i,
				),
			});
		try {
			const res = await client.api.payments.basket.items[":workId"].$put({
				param: { workId: String(item.workId) },
				json: {
					...(item.quantity != null ? { quantity: item.quantity } : {}),
					...(item.options !== undefined ? { options: item.options } : {}),
				},
			});
			if (!res.ok) {
				publishServer(prev);
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				return { ok: false as const, error: body?.error ?? "Couldn't change that." };
			}
			const body = (await res.json()) as unknown as { items: ServerItem[] };
			publishServer({ items: body.items });
			return { ok: true as const };
		} catch {
			publishServer(prev);
			return { ok: false as const, error: "Couldn't change that." };
		}
	},
	async remove(id: { kind: "work"; workId: number } | { kind: "badge"; badgeId: number }) {
		const prev = serverCurrent;
		if (prev)
			publishServer({
				items: prev.items.filter((i) =>
					i.kind === "badge"
						? !(id.kind === "badge" && i.badgeId === id.badgeId)
						: !(id.kind === "work" && i.workId === id.workId),
				),
			});
		try {
			if (id.kind === "badge") {
				await client.api.payments.basket.badges[":badgeId"].$delete({
					param: { badgeId: String(id.badgeId) },
				});
			} else {
				await client.api.payments.basket.items[":workId"].$delete({
					param: { workId: String(id.workId) },
				});
			}
		} catch {
			// Reconcile on the next read either way.
		}
		refreshServerBasket();
	},
	async clear() {
		const prev = serverCurrent;
		publishServer({ items: [] });
		try {
			await client.api.payments.basket.$delete();
		} catch {
			// Reconcile on the next read either way.
		}
		if (prev) refreshServerBasket();
	},
};

/** The scratchpad verbs, per-hook (they close over the hook's state list). */
function scratchApi(scratchItems: BasketWorkItem[]): BasketApi {
	return {
		items: scratchItems,
		count: scratchItems.length,
		add: (item: BasketItem) => {
			// A scratch add is a Work add: a visitor picking a Badge rung is detoured
			// through sign-in/up before anything is held, so no Badge line exists in the
			// anonymous half (and this cast is never a lie).
			const work = item as BasketWorkItem;
			const current = read();
			if (current.some((i) => i.workId === work.workId)) return { ok: true as const };
			// A basket carries any number of creators (2026-10-15) — the shared charge is
			// settled at checkout, so the scratchpad appends exactly as the server's basket
			// does, and the sign-in merge folds it in the same way.
			write([...current, work]);
			return { ok: true as const };
		},
		update: (item) => {
			const current = read();
			write(
				current.map((i) =>
					i.workId === item.workId
						? {
								...i,
								...(item.quantity != null ? { quantity: item.quantity } : {}),
								...(item.options !== undefined ? { options: item.options } : {}),
							}
						: i,
				),
			);
			return { ok: true as const };
		},
		remove: (id) => {
			// The scratchpad is works-only (a Badge remove names nothing that was ever
			// scratchable — the anonymous flow detours before anything is held).
			if (id.kind === "badge") return;
			write(read().filter((i) => i.workId !== id.workId));
		},
		clear: () => write([]),
		has: (workId: number) => scratchItems.some((i) => i.workId === workId),
		hasBadge: () => false,
	};
}

export interface BasketApi {
	items: BasketItem[];
	count: number;
	add: (
		item: BasketItem,
	) =>
		| { ok: true }
		| { ok: false; error: string }
		| Promise<{ ok: true } | { ok: false; error: string }>;
	remove: (
		id: { kind: "work"; workId: number } | { kind: "badge"; badgeId: number },
	) => void | Promise<void>;
	/** Change a Work line's count or chosen values — the basket page's own controls. */
	update: (item: {
		workId: number;
		quantity?: number;
		options?: Array<{ name: string; label: string }>;
	}) =>
		| { ok: true }
		| { ok: false; error: string }
		| Promise<{ ok: true } | { ok: false; error: string }>;
	clear: () => void | Promise<void>;
	has: (workId: number) => boolean;
	/** Whether the rung is already in the basket — signed-in mode only; false while anonymous. */
	hasBadge: (badgeId: number) => boolean;
}

/**
 * Drop Works the server says are no longer wanted — kept for the checkout-complete path,
 * which calls `clear` on the mode that's active. A no-op for the scratchpad's callers
 * today (nothing purchases anonymously), harmless for both.
 */
export function pruneBasket(purchasedWorkIds: number[]) {
	// Scratch mode only — a signed-in basket clears through the API (see `clear`).
	if (read().length === 0) return;
	write(read().filter((i) => !purchasedWorkIds.includes(i.workId)));
}
