// SPDX-License-Identifier: Apache-2.0
/**
 * The conversation with the identity server: where it answers, and one call at a time.
 *
 * Split out of `hosted-accounts.ts` so the modules that all talk to the node share one answer
 * about where it is and what a retryable failure is. That mattered the moment the session store
 * and the account module needed each other: a password check lives with the account, a session
 * lives with the store, and neither should import the other just to reach `fetch`.
 */
import { atprotoWriteRefusal, warnRefusalOnce } from "../lib/atproto-network.js";

/**
 * Where the Anthers-run Personal Data Server answers, or the empty string when unset.
 *
 * 🛑 **Also the empty string when this process may not write there** — a server on the real
 * network, named from a machine that is not a public deployment. Everything that talks to the
 * node already treats an unset server as a closed door, so refusing here closes every door at
 * once: no account is created, no record written, no handle changed and no directory operation
 * requested. See `lib/atproto-network.ts`.
 */
export function pdsUrl(): string {
	const url = process.env.HOSTED_PDS_URL?.trim() ?? "";
	if (!url) return "";
	const refusal = atprotoWriteRefusal(url);
	if (refusal) {
		warnRefusalOnce(refusal);
		return "";
	}
	return url;
}

/** Where the node answers, for callers that want the value without the empty-string meaning. */
export function hostedPdsUrl(): string {
	return pdsUrl();
}

/**
 * One call to the node, with the two failure kinds kept apart.
 *
 * Exported for every module that talks to the same server about the same accounts, so none of
 * them grows a second opinion about what a retryable failure is.
 */
export async function nodeCall(
	path: string,
	init: RequestInit & { token?: string },
	doFetch: typeof fetch,
): Promise<
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; retryable: boolean; error: string; message?: string }
> {
	// Not retryable: nothing but a change of configuration will make a server appear, and a
	// relative path handed to `fetch` would fail in a way that reads as the node being down.
	const base = pdsUrl();
	if (!base) {
		return { ok: false, retryable: false, error: "NoNode", message: "no usable HOSTED_PDS_URL" };
	}
	const { token, ...rest } = init;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	let res: Response;
	try {
		res = await doFetch(`${base}${path}`, {
			...rest,
			headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		return { ok: false, retryable: true, error: err instanceof Error ? err.message : "no answer" };
	}
	if (res.ok) {
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return { ok: true, body };
	}
	const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
	// A 5xx is the node having a bad day; a 4xx is the node's considered answer. Retrying the
	// first is the whole point, and retrying the second is a loop.
	return {
		ok: false,
		retryable: res.status >= 500 || res.status === 429,
		error: body.error || body.message || `HTTP ${res.status}`,
		// ⚠️ **Kept apart from `error`, because `error` is the CODE when the node sends one** and
		// the prose is the only place some refusals say what actually happened. Callers should
		// still branch on the code — the prose is upstream's wording and moves between versions
		// — but a log line with only `InvalidRequest` in it has thrown away the whole clue.
		message: body.message,
	};
}
