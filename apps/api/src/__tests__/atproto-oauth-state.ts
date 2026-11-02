// SPDX-License-Identifier: Apache-2.0
/**
 * The browser-binding pair a fake ATProto callback needs.
 *
 * The real flow sets `atproto_oauth_state` at `/auth` and carries the same nonce inside the
 * OAuth state. A suite that calls `/callback` directly has to present both, exactly as a
 * browser would; presenting only the state is the cross-site callback the guard exists to
 * refuse.
 */
export function boundState(state: Record<string, unknown>): { state: string; cookie: string } {
	const nonce = crypto.randomUUID();
	return {
		state: JSON.stringify({ ...state, nonce }),
		cookie: `atproto_oauth_state=${nonce}`,
	};
}
