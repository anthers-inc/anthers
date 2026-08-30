// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The buyer's basket — which Works they mean to buy on one charge.
 *
 * **Client-side, in `localStorage`, and deliberately so.** A basket is a scratchpad, not a
 * record: nothing here is money, nothing is an entitlement, and losing one costs a buyer
 * nothing but re-clicking. Putting it in Postgres would buy cross-device continuity at the
 * price of a table, a migration and a sync story, for state whose whole lifespan is
 * usually one session.
 *
 * 🚨 **It is therefore not trusted.** Every id here is re-resolved server-side at
 * `/basket/quote` and `/basket/checkout` — price, release state, whether the buyer already
 * owns it, and which creator it belongs to. A tampered basket buys nothing it shouldn't;
 * the worst it can do is quote itself a number the server then refuses.
 *
 * ⚠️ **One creator per basket**, enforced here as a *courtesy* and on the server as the
 * rule. Stripe's `transfer_data.destination` names a single connected account, so a basket
 * spanning two creators cannot be one destination charge — see `resolveBasket`. Adding a
 * second creator's Work replaces the basket rather than silently failing at checkout,
 * because discovering it at the payment step is the worst possible moment.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "anthers_basket";
/** Bumped when the stored shape changes, so an old basket is dropped rather than parsed. */
const VERSION = 1;

export interface BasketItem {
	workId: number;
	slug: string;
	title: string;
	price: string;
	creatorUsername: string;
	thumbnail?: string | null;
}

interface StoredBasket {
	version: number;
	items: BasketItem[];
}

function read(): BasketItem[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as StoredBasket;
		if (parsed?.version !== VERSION || !Array.isArray(parsed.items)) return [];
		return parsed.items;
	} catch {
		// A corrupt basket is an empty basket. Never throw out of storage access —
		// Safari's private mode throws on `localStorage` entirely.
		return [];
	}
}

function write(items: BasketItem[]) {
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
 * Read and mutate the basket, staying in sync across components and tabs.
 *
 * Two subscriptions on purpose: `storage` covers other tabs, and a custom event covers
 * this one — a header badge that only updated in the tab you weren't using would read as
 * a bug in the basket rather than in the wiring.
 */
export function useBasket() {
	const [items, setItems] = useState<BasketItem[]>([]);

	useEffect(() => {
		setItems(read());
		const sync = () => setItems(read());
		window.addEventListener("storage", sync);
		window.addEventListener(EVENT, sync);
		return () => {
			window.removeEventListener("storage", sync);
			window.removeEventListener(EVENT, sync);
		};
	}, []);

	const add = useCallback((item: BasketItem) => {
		const current = read();
		if (current.some((i) => i.workId === item.workId)) return { ok: true as const };
		// A different creator means a different charge. Replace rather than reject: the
		// buyer's most recent intent is the one to honor, and telling them at the moment
		// they click is far better than at checkout.
		const clashed = current.length > 0 && current[0].creatorUsername !== item.creatorUsername;
		const next = clashed ? [item] : [...current, item];
		write(next);
		return { ok: true as const, replacedCreator: clashed ? current[0].creatorUsername : null };
	}, []);

	const remove = useCallback((workId: number) => {
		write(read().filter((i) => i.workId !== workId));
	}, []);

	const clear = useCallback(() => write([]), []);

	const has = useCallback((workId: number) => items.some((i) => i.workId === workId), [items]);

	return { items, add, remove, clear, has, count: items.length };
}

/** Drop Works the server says are no longer buyable — called after a completed checkout. */
export function pruneBasket(purchasedWorkIds: number[]) {
	write(read().filter((i) => !purchasedWorkIds.includes(i.workId)));
}
