// SPDX-License-Identifier: Apache-2.0
//
// The Noun Project Icon API client, RUNTIME side — the Badge Maker's vendor leg.
//
// 🚨 PORTED, NOT IMPORTED. `scripts/noun/` is authoring tooling and nothing that
// ships may import it (`scripts/noun/authoring-time.test.ts` enforces it, and its
// docblock named this build coming). What differs from the authoring client is the
// credential and what surrounds it: a runtime key is a product surface with its own
// spend cap, its own budget state and its own blocklist — that state lives in
// `services/`, not here.
//
// ⚠️ ASSET URLS EXPIRE WITHIN AN HOUR, so this is a sourcing API and can never be
// a serving one. Every byte this client returns is consumed in the same request —
// composed, rasterized and discarded — and nothing Anthers renders may point at a
// Noun Project URL. `services/badge-art-compose.ts` is the only consumer.

import { authorizationHeader } from "./oauth";

const API_ROOT = "https://api.thenounproject.com";

/**
 * The one color every asset is fetched in, ever.
 *
 * Black, and never varied: `normalizeToRecolorable` strips baked fills so one injected
 * color controls the icon, and the creator's color is applied server-side at composition.
 * The fetch itself must not bake a color in — fetching per color would cost a full icon
 * call per color per icon and break the recolor-at-composition rule.
 */
export const DOWNLOAD_COLOR = "000000";

/**
 * What one request costs, in the vendor's own billing vocabulary.
 *
 * ⭐ **An icon call is any request carrying an icon ID; everything else is a service
 * call.** That is the vendor's definition rather than a guess at one, and the two differ
 * almost fourfold — $0.0095 against $0.0025 — so a budget that cannot tell them apart
 * cannot bound spend.
 */
export type CallClass = "icon" | "service";

/** Published list prices, for the spend estimator the circuit breaker reads. */
export const CALL_PRICE: Record<CallClass, number> = { icon: 0.0095, service: 0.0025 };

/** Any path under `/v2/icon/<id>` is an icon call; `/v2/icon` (search) is not. */
export function callClass(path: string): CallClass {
	return /^\/v2\/icon\/(?!autocomplete\b)[^/]+/.test(path) ? "icon" : "service";
}

/**
 * The runtime credential, from the API component's environment only.
 *
 * 🚨 **Deliberately NOT the authoring credential's name.** The authoring key's env
 * names appear nowhere that ships — the authoring-time scan fails the build if they
 * do — so the runtime names differ by the whole string, keeping that scan true
 * without weakening it and keeping the two keys un-confusable. The runtime key is the
 * one with the monthly spend cap configured on the vendor dashboard.
 */
export async function credentials(): Promise<{ key: string; secret: string }> {
	const key = (process.env.NOUNPRO_KEY ?? "").trim();
	const secret = (process.env.NOUNPRO_SECRET ?? "").trim();
	if (!key || !secret) {
		throw new Error(
			"no Noun Project runtime credential: NOUNPRO_KEY/NOUNPRO_SECRET are unset. " +
				"The runtime key is provisioned through `make spec-apply`, never declared in the spec file.",
		);
	}
	return { key, secret };
}

export class NounApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`Noun Project API ${status} on ${path}: ${body.slice(0, 400)}`);
		this.name = "NounApiError";
	}
}

/**
 * One signed GET.
 *
 * 🚨 **A caller may not choose the download color.** The parameter is mandatory —
 * omitting it answers `400 Must provide a hexadecimal color value` — so the rule is
 * never to vary it, and this client enforces the pin the way the authoring one does.
 */
export async function get<T>(
	path: string,
	params: Record<string, string | number | boolean> = {},
): Promise<T> {
	if (path.includes("/download") && params.color !== DOWNLOAD_COLOR) {
		throw new Error(
			`refusing a download color other than ${DOWNLOAD_COLOR}: assets are fetched in one ` +
				"color and recolored at composition. Fetching per color bakes the color in and " +
				"costs a full icon call for every color of every icon.",
		);
	}
	const entries: [string, string][] = Object.entries(params).map(([k, v]) => [k, String(v)]);
	const url = new URL(API_ROOT + path);
	for (const [k, v] of entries) url.searchParams.set(k, v);

	const { key, secret } = await credentials();
	const res = await fetch(url, {
		headers: {
			Authorization: authorizationHeader({
				method: "GET",
				url: url.toString(),
				consumerKey: key,
				consumerSecret: secret,
				params: entries,
			}),
			Accept: "application/json",
		},
	});
	if (!res.ok) throw new NounApiError(res.status, path, await res.text());
	return (await res.json()) as T;
}

// ── The shapes this product actually reads ────────────────────────────────────
// Partial by design: the API returns more than this and none of the rest is used.
// 🚨 Every search response carries `creator`, `permalink`, `license_description` and
// `attribution` for free — provenance rides along, and GET /v2/icon/{id} is never
// called, because a separate metadata fetch is an icon call spent on nothing.

/** The fields a provenance row is written from, all of which ride along on a search. */
export interface NounIcon {
	id: number | string;
	term?: string;
	permalink?: string;
	attribution?: string;
	license_description?: string;
	thumbnail_url?: string;
	creator?: { name?: string; permalink?: string; username?: string };
	[key: string]: unknown;
}

export const search = (
	query: string,
	params: Record<string, string | number | boolean> = {},
): Promise<{
	icons: NounIcon[];
	next_page?: string | null;
	total?: number;
	/** Every search response carries the month's counters, so tracking spend is free. */
	usage_limits?: unknown;
}> => get("/v2/icon", { query, ...params });

export const moreLikeThis = (
	id: string | number,
	params: Record<string, string | number | boolean> = {},
): Promise<{ icons: NounIcon[] }> => get(`/v2/icon/${id}/more-like-this`, params);

/**
 * The icon's SVG in {@link DOWNLOAD_COLOR}, base64-decoded. Costs one icon call.
 *
 * 🚨 **WHAT THIS RETURNS MAY NOT BE WRITTEN ANYWHERE.** Creating the key required
 * agreeing that the app will not cache SVG files, so `services/badge-art-compose.ts`
 * fetches, composes, rasterizes and discards the vector inside one request — nothing
 * else ever calls this, and no caller may persist what it returns.
 */
export async function downloadSvg(id: string | number): Promise<string> {
	const res = await get<{ base64_encoded_file?: string; content_type?: string }>(
		`/v2/icon/${id}/download`,
		{ filetype: "svg", color: DOWNLOAD_COLOR },
	);
	if (!res.base64_encoded_file) {
		throw new Error(`download for icon ${id} returned no file (content_type=${res.content_type})`);
	}
	return Buffer.from(res.base64_encoded_file, "base64").toString("utf8");
}