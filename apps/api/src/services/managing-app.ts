// SPDX-License-Identifier: Apache-2.0
/**
 * Anthers as the managing app a gated space names: the identity, where its document lives,
 * and the one service entry a space authority resolves before it calls us.
 *
 * The protocol addresses a managing app the way it addresses any service: a DID with an
 * optional fragment, resolved through the DID document at that DID's own location. For a
 * `did:web`, that location is derived from the host — so the document is served by whatever
 * host answers the request, and the `id` it carries is that host made into a DID. Deriving
 * rather than pinning is what keeps dev, a worktree and production from each needing a
 * variable, and it is the correct reading of `did:web` rather than a convenience.
 *
 * ⚠️ **`did:web` cannot carry a path here.** The atproto resolver refuses a `did:web` with a
 * path (`UnsupportedDidWebPathError`), so the document is at `/.well-known/did.json` on the
 * host root and that path must reach the API in production, where the site owns the root.
 * The service endpoint can carry one, and does: the route lives under `/api` like the rest
 * of this API.
 */

/** The service fragment a gated space names. It is ours; nothing else publishes one. */
export const MANAGING_APP_SERVICE = "anthers";

/** The XRPC method a space authority calls on us. */
export const CHECK_USER_ACCESS_METHOD = "com.atproto.simplespace.checkUserAccess";

export interface ManagingAppIdentity {
	/** `did:web:<host>`, as the DID document's own `id`. */
	did: string;
	/** `did:web:<host>#anthers`, the value a space's `managingApp` names and a JWT's `aud`. */
	serviceId: string;
	/** The origin the XRPC routes answer on — the host root, where `/xrpc/…` lives. */
	endpoint: string;
}

/**
 * The managing-app identity for the origin a request arrived at.
 *
 * A port is part of the DID (`did:web:localhost%3A8000`), percent-encoded as the DID syntax
 * requires — that is what makes a local session's identity different from production's
 * instead of accidentally colliding with it.
 *
 * ⚠️ **The endpoint is the origin and not the API's `/api` mount.** An atproto service answers
 * XRPC at `/xrpc/<nsid>` on its root, and the protocol's client builds that URL by replacing
 * the base's path — so an endpoint of `https://anthers.org/api` would silently be called as
 * `https://anthers.org/xrpc/…`. The route therefore lives at the root too, and the ingress
 * sends `/xrpc` to the API beside `/.well-known/did.json`.
 */
export function managingAppFor(origin: string): ManagingAppIdentity {
	const url = new URL(origin);
	const host = url.port ? `${url.hostname}%3A${url.port}` : url.hostname;
	const did = `did:web:${host}`;
	return {
		did,
		serviceId: `${did}#${MANAGING_APP_SERVICE}`,
		endpoint: url.origin,
	};
}

/**
 * The DID document that names this app's service endpoint.
 *
 * The service `type` is descriptive and deliberately not one of the protocol's — the resolver
 * matches on the fragment alone, and claiming `AtprotoPersonalDataServer` for something that
 * is not a PDS would be a false claim in a document the network reads.
 */
export function didDocumentFor(identity: ManagingAppIdentity): Record<string, unknown> {
	return {
		"@context": ["https://www.w3.org/ns/did/v1"],
		id: identity.did,
		service: [
			{
				id: `#${MANAGING_APP_SERVICE}`,
				type: "AnthersManagingApp",
				serviceEndpoint: identity.endpoint,
			},
		],
	};
}
