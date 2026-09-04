// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Noun Project Icon API client, for AUTHORING-TIME tooling only.
//
// 🚨 NOTHING THAT SHIPS MAY IMPORT THIS. `packages/brand` commits its generated
// markup precisely so a fork builds with no key, no network and no private
// library, and `authoring-time.test.ts` fails if the credential's name appears
// anywhere on the deploy path. The scripts here are run by a person, occasionally,
// and their output is committed.
//
// ⚠️ ASSET URLS EXPIRE WITHIN AN HOUR, so this is a sourcing API and can never be
// a serving one. Every byte it returns has to be written to disk by the caller;
// nothing Anthers renders may point at a Noun Project URL.

import { bwsSecrets } from "../bws";
import { authorizationHeader } from "./oauth";

const API_ROOT = "https://api.thenounproject.com";

/**
 * The one color every asset is fetched in, ever.
 *
 * Black because that is what the existing library is and what the codegen's `normalize()`
 * is written against — it strips the baked fill so a single injected color controls the
 * icon, which is how one stored asset serves every theme.
 */
export const DOWNLOAD_COLOR = "000000";

/**
 * What one request costs, in the vendor's own billing vocabulary.
 *
 * ⭐ **An icon call is any request carrying an icon ID; everything else is a
 * service call.** That is the vendor's definition rather than a guess at one, and
 * the two differ almost fourfold — $0.0095 against $0.0025 — so a tool that
 * cannot tell them apart cannot tell you what a sourcing pass will cost.
 */
export type CallClass = "icon" | "service";

/** Published list prices, for the running total a session prints. */
export const CALL_PRICE: Record<CallClass, number> = { icon: 0.0095, service: 0.0025 };

/** Any path under `/v2/icon/<id>` is an icon call; `/v2/icon` (search) is not. */
export function callClass(path: string): CallClass {
	return /^\/v2\/icon\/(?!autocomplete\b)[^/]+/.test(path) ? "icon" : "service";
}

const tally: Record<CallClass, number> = { icon: 0, service: 0 };

/** What this process has spent so far, for the line every command prints when it finishes. */
export function spent(): { icon: number; service: number; dollars: number } {
	return {
		...tally,
		dollars: tally.icon * CALL_PRICE.icon + tally.service * CALL_PRICE.service,
	};
}

export function reportSpend(): void {
	const s = spent();
	if (s.icon + s.service === 0) return;
	console.log(
		`\n  ${s.icon} icon call(s), ${s.service} service call(s) — about $${s.dollars.toFixed(4)} at list price.`,
	);
}

let cached: { key: string; secret: string } | null = null;

/**
 * The API credential, from the environment or from the "Anthers Dev" Bitwarden project.
 *
 * ⚠️ **Development credentials, deliberately, even though production holds a copy.**
 * This tooling writes files a person then commits; it has no business holding the
 * key production would use to serve creators, and `bwsSecrets` binds the role to
 * its own machine-account token so asking for `dev` cannot reach the other project.
 */
export async function credentials(): Promise<{ key: string; secret: string }> {
	if (cached) return cached;
	const fromEnv = {
		key: (process.env.NOUN_PROJECT_KEY ?? "").trim(),
		secret: (process.env.NOUN_PROJECT_SECRET ?? "").trim(),
	};
	if (fromEnv.key && fromEnv.secret) {
		cached = fromEnv;
		return cached;
	}
	let secrets: Map<string, string>;
	try {
		secrets = await bwsSecrets("dev");
	} catch (err) {
		throw new Error(
			`no Noun Project credential: NOUN_PROJECT_KEY/NOUN_PROJECT_SECRET are unset and the ` +
				`Bitwarden read failed — ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const key = secrets.get("NOUN_PROJECT_KEY");
	const secret = secrets.get("NOUN_PROJECT_SECRET");
	if (!key || !secret) {
		throw new Error(
			"no Noun Project credential: the Anthers Dev project has no NOUN_PROJECT_KEY / " +
				"NOUN_PROJECT_SECRET. Set them there, or export both for a one-off run.",
		);
	}
	cached = { key, secret };
	return cached;
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
 * 🚨 **A caller may not choose the download color, and `downloadSvg` pins it to black.**
 * The rule worth keeping is *never fetch the same icon twice* — `normalize()` in the
 * codegen strips baked fills so one injected color controls each icon, and the whole
 * site recolors from a single file of design tokens, so a palette change re-downloads
 * nothing and must not start to. Fetching per color would bake a color into the asset,
 * cost a full icon call for every color of every icon, and break token-driven theming.
 *
 * ⚠️ **The parameter itself is not optional, whatever the design notes say.** The
 * endpoint answers `400 Must provide a hexadecimal color value` without it, so
 * "do not pass `color`" is not implementable and "do not *vary* `color`" is what that
 * instruction has always meant. Black is the value, because black is what the existing
 * library is and what `normalize()` is written against.
 */
export async function get<T>(
	path: string,
	params: Record<string, string | number | boolean> = {},
): Promise<T> {
	if (path.includes("/download") && params.color !== DOWNLOAD_COLOR) {
		throw new Error(
			`refusing a download color other than ${DOWNLOAD_COLOR}: assets are stored in one ` +
				"color and recolored from design tokens. Fetching per color bakes the color in and " +
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
	tally[callClass(path)]++;
	if (!res.ok) throw new NounApiError(res.status, path, await res.text());
	return (await res.json()) as T;
}

// ── The shapes this repository actually reads ────────────────────────────────
// Partial by design: the API returns more than this and none of the rest is used.

export interface NounCollectionRef {
	id: number;
	name?: string;
	slug?: string;
}

export interface NounIcon {
	// The response carries more than this and none of the rest is used, so reads of an
	// undeclared field are typed `unknown` rather than refused — which is what lets a
	// probe ask whether a field exists at all without inventing a type for it.
	[key: string]: unknown;
	id: number | string;
	term: string;
	permalink?: string;
	attribution?: string;
	license_description?: string;
	thumbnail_url?: string;
	icon_url?: string;
	creator?: { name?: string; permalink?: string; username?: string };
	collections?: NounCollectionRef[];
	tags?: (string | { slug?: string })[];
}

export interface NounUsage {
	limits?: { monthly?: Record<string, number>; daily?: Record<string, number> };
	usage?: { monthly?: Record<string, number>; daily?: Record<string, number> };
	[key: string]: unknown;
}

export const usage = () => get<NounUsage>("/v2/client/usage");

export const icon = (id: string | number) => get<{ icon: NounIcon }>(`/v2/icon/${id}`);

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
 * ⚠️ **Fetch each icon once, ever.** The color is pinned rather than chosen, so there
 * is never a reason to call this twice for the same id — see the note on `get`.
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
