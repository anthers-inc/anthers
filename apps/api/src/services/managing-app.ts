// SPDX-License-Identifier: Apache-2.0
/**
 * Anthers as the managing app a gated space names: the identity, where its document lives,
 * and the one service entry a space authority resolves before it calls us.
 *
 * The protocol addresses a managing app the way it addresses any service: a DID with an
 * optional fragment, resolved through the DID document at that DID's own location. For a
 * `did:web`, that location is the host. A checkout therefore answers from the host that
 * served the request, which is what makes dev and a worktree each their own identity without
 * a variable; a deployment answers from its own recorded origin, because the proxy forwards
 * over plain HTTP and the scheme on the wire is not the one the network resolves.
 *
 * ⚠️ **`did:web` cannot carry a path here.** The atproto resolver refuses a `did:web` with a
 * path (`UnsupportedDidWebPathError`), so the document is at `/.well-known/did.json` on the
 * host root and that path must reach the API in production, where the site owns the root.
 * The service endpoint can carry one, and does: the route lives under `/api` like the rest
 * of this API.
 */

import { publicOrigin } from "../lib/deployment.js";

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
 * The managing-app identity for a request.
 *
 * ⚠️ **A deployed process takes its origin from configuration, not from the request.** App
 * Platform terminates TLS and forwards the request over plain HTTP, so a request-derived
 * origin can read `http://` while the network resolves the document over `https://` — and the
 * service endpoint handed to a space authority would then point at a scheme nothing answers
 * on. `publicOrigin()` is the deployment's own statement of where it is reachable; in a
 * checkout it answers null, which is exactly where the request's origin is the right answer.
 */
export function managingAppForRequest(requestUrl: string): ManagingAppIdentity {
	return managingAppFor(publicOrigin() ?? new URL(requestUrl).origin);
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
