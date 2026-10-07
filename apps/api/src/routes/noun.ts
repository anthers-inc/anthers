// SPDX-License-Identifier: Apache-2.0
/**
 * The Noun Project search proxy — the Badge Maker's service-call surface, behind
 * `requireAuth` + `requireCreator`.
 *
 * 🚨 **Free-text search over the catalog is exposed to creators designing their own
 * ladder, and to nobody else.** This is what keeps the surface small and accountable,
 * and it is the reason Stickers and Anthers' own Badges are fixed lists rather than
 * pickers.
 *
 * 🚨 **EVERY SEARCH IS A LIVE VENDOR CALL, AND SEARCH RESULTS ARE NOT CACHED AT ALL, IN
 * ANY FORM.** Noun Project's API access review (2026-10-02) stated the term in writing:
 * icon metadata and PNG thumbnails may be cached, but icon search results may not. So
 * there is deliberately no query cache, no result store and no thumbnail cache here —
 * what a search returns goes straight to the requesting creator's browser, and the
 * vendor's CDN thumbnails are session-only (their URLs expire within an hour). What
 * persists is only ever what a creator SELECTED: the provenance row and the composed
 * Badge PNG, written by `badge-art-compose.ts`.
 *
 * 🚨 **`GET /v2/icon/{id}` is never called by any route here** — every provenance field
 * rides along on a search response, and a separate metadata fetch is an icon call spent
 * on nothing. `/more-like-this` results are search results under the same no-cache term,
 * and each suggestion request is its own live icon call, which is why the budget counts
 * it as one.
 *
 * Every route here checks the blocklist's term half BEFORE the vendor call and the
 * per-creator budget before it too; both guards degrade politely (a structured refusal,
 * never a 500) rather than breaking the picker.
 */

import { Hono } from "hono";
import { requireAuth, requireCreator } from "../middleware/auth";
import {
	checkBudget,
	budgetRefusal,
	breakerAllows,
	recordSpend,
	spendToday,
} from "../services/noun-budget";
import { filterBlockedIcons, queryRefused } from "../services/noun-blocklist";
import { moreLikeThis, search, type NounIcon } from "../lib/noun/client";

const nounRoutes = new Hono();

/** The fields a client may see about one icon — the picker's byline and preview. */
function publicIcon(icon: NounIcon) {
	return {
		id: String(icon.id),
		term: icon.term ?? "",
		thumbnailUrl: icon.thumbnail_url ?? null,
		artistName: icon.creator?.name ?? icon.attribution ?? "Unknown artist",
		artistPermalink: icon.creator?.permalink ?? null,
		licenseDescription: icon.license_description ?? "Unknown",
		attribution: icon.attribution ?? "",
	};
}

/**
 * Search the Noun Project catalog.
 *
 * 🚨 **The term blocklist refuses the query BEFORE the vendor call** — a refused search
 * is a result that never exists here and a call never spent. Then the budget, then the
 * breaker, then the one live call; the response carries nothing but the icons and
 * whether more pages exist, and nothing about it is stored anywhere.
 */
nounRoutes.get("/search", requireAuth, requireCreator, async (c) => {
	const query = (c.req.query("q") ?? "").trim();
	if (!query) return c.json({ error: "Search for something.", icons: [] }, 400);
	if (query.length > 100) return c.json({ error: "That search is too long.", icons: [] }, 400);
	// Cursor pagination, passed straight through — never a result cache's page key,
	// because the results themselves are never held.
	const page = (c.req.query("page") ?? "").trim();

	const user = c.get("user");
	if (await queryRefused(query)) {
		// 🚨 BLOCKLIST REFUSAL — the result never exists here and the vendor call is
		// never made; this branch returning is the control flow that guarantees it.
		return c.json({ refused: true, icons: [] }, 200);
	}

	const klass = "service" as const;
	const verdict = await checkBudget(user.id, klass);
	const breakerOpen = !(await breakerAllows(klass));
	if (!verdict.ok || breakerOpen) {
		return c.json(budgetRefusal(verdict, breakerOpen), 429);
	}

	try {
		const res = await search(query, page ? { page } : {});
		await recordSpend(user.id, klass);
		const icons = await filterBlockedIcons(res.icons ?? []);
		return c.json({
			icons: icons.map(publicIcon),
			nextPage: res.next_page ?? null,
		});
	} catch (err) {
		// The vendor's own 429 means the key hit a burst cap — degrade rather than fail,
		// with the same structured shape the budget refusal takes so the picker treats
		// both identically.
		if (err instanceof Error && err.name === "NounApiError" && /429/.test(err.message)) {
			return c.json({ code: "vendor_rate_limited", icons: [] }, 429);
		}
		throw err;
	}
});

/**
 * Style matching — the feature the whole library approach was taken for. One icon id in,
 * the visually similar set out, as its own live icon call under the same guards.
 */
nounRoutes.get("/icons/:id/similar", requireAuth, requireCreator, async (c) => {
	const id = c.req.param("id");
	if (!/^\d+$/.test(id)) return c.json({ error: "Bad icon id.", icons: [] }, 400);

	const user = c.get("user");
	const klass = "icon" as const;
	const verdict = await checkBudget(user.id, klass);
	const breakerOpen = !(await breakerAllows(klass));
	if (!verdict.ok || breakerOpen) {
		return c.json(budgetRefusal(verdict, breakerOpen), 429);
	}

	try {
		const res = await moreLikeThis(id, {});
		await recordSpend(user.id, klass);
		const icons = await filterBlockedIcons(res.icons ?? []);
		return c.json({ icons: icons.map(publicIcon) });
	} catch (err) {
		if (err instanceof Error && err.name === "NounApiError" && /429/.test(err.message)) {
			return c.json({ code: "vendor_rate_limited", icons: [] }, 429);
		}
		throw err;
	}
});

/**
 * Where this creator's daily budget stands — the picker's meter, and the one read on
 * this module that spends nothing.
 */
nounRoutes.get("/budget", requireAuth, requireCreator, async (c) => {
	const user = c.get("user");
	const verdict = await spendToday(user.id);
	const breakerOpen = !(await breakerAllows("service"));
	return c.json({ ...verdict, breakerOpen });
});

export { nounRoutes };