// SPDX-License-Identifier: Apache-2.0
/**
 * The two network-facing routes that make Anthers a spaces managing app.
 *
 * `GET /.well-known/did.json` is the identity: a `did:web` document naming this API as the
 * `#anthers` service, which a space authority resolves before it calls anything. It is served
 * at the host root rather than under `/api` because that is where `did:web` looks, and its
 * `id` names the deployment's own origin — see `services/managing-app.ts` for why that is
 * configuration in a deployment and the request in a checkout, rather than either everywhere.
 *
 * `GET /xrpc/com.atproto.simplespace.checkUserAccess` is the gate itself. The caller is a
 * space authority's PDS, not a browser: it authenticates with a service-auth JWT signed by the
 * authority's `#atproto` key, and the route answers `{authorized}` from `resolveAccess`. There
 * is no session on this route and no cookie, which is why it is outside every authenticated
 * surface and why its own verification is the whole of its authorization.
 *
 * 🚨 **An unverifiable caller is refused with a 401, and the route answers no question
 * first.** The protocol's caller treats a failed call as a refusal, so an error is already
 * safe; what would not be safe is checking the space, the user or the Work before checking the
 * signature, because that turns the route into an oracle about other people's manifests.
 */
import { Hono } from "hono";
import {
	CHECK_USER_ACCESS_METHOD,
	didDocumentFor,
	managingAppForRequest,
} from "../services/managing-app.js";
import { checkRate, clientIp } from "../services/rate-limit.js";
import {
	networkDidResolver,
	type ResolveDid,
	ServiceAuthError,
	verifyServiceAuth,
} from "../services/service-auth.js";
import { authorizeSpaceAccess, type SpaceAccessDecision } from "../services/space-gate.js";

export interface ManagingAppRouteOptions {
	/** Test seam: a DID resolver that does not reach the network. */
	resolveDid?: ResolveDid;
	/** Test seam: the access decision, so a staging run can exercise the protocol without a Work. */
	authorize?: (query: {
		space: string;
		authority: string;
		userDid: string;
		access: string;
	}) => Promise<SpaceAccessDecision>;
	now?: () => number;
}

/** The bearer token out of an `Authorization` header, or null. */
function bearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, ...rest] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer") return null;
	const token = rest.join(" ").trim();
	return token.length > 0 ? token : null;
}

export function createManagingAppRoutes(options: ManagingAppRouteOptions = {}): Hono {
	const resolveDid = options.resolveDid ?? networkDidResolver;
	const authorize = options.authorize ?? authorizeSpaceAccess;
	const now = options.now ?? Date.now;

	return new Hono()
		.get("/.well-known/did.json", (c) => {
			const identity = managingAppForRequest(c.req.url);
			// The media type is `application/did+ld+json`; JSON is served because every
			// resolver accepts it and a proxy that rewrites an unfamiliar type is a worse
			// failure than the one the precise type would avoid.
			return c.json(didDocumentFor(identity), 200, {
				"Cache-Control": "public, max-age=300",
			});
		})
		.get(`/xrpc/${CHECK_USER_ACCESS_METHOD}`, async (c) => {
			const limited = await checkRate(
				// The cost a bad caller imposes is a DID resolution, which is an outbound
				// HTTPS request. The caller is one PDS per space authority, so a minute's
				// budget is generous for real traffic and small for anything else.
				"space-check-user-access",
				clientIp(c.req.raw.headers),
				60,
				60,
			);
			if (!limited.ok) {
				return c.json({ error: "RateLimited", message: "too many requests" }, 429, {
					"Retry-After": String(limited.retryAfterSecs),
				});
			}

			const space = c.req.query("space");
			const user = c.req.query("user");
			const access = c.req.query("access");
			// `clientId` is present when the authority verified a client attestation
			// before asking. It reaches the resolver's answer only through the PDS's own
			// perimeter today; accepted here so the claim is not dropped on the floor.
			if (!space || !user || !access) {
				return c.json(
					{
						error: "InvalidRequest",
						message: "space, user and access are required",
					},
					400,
				);
			}

			const token = bearerToken(c.req.header("Authorization"));
			if (!token) {
				return c.json({ error: "AuthRequired", message: "service auth is required" }, 401);
			}

			const identity = managingAppForRequest(c.req.url);
			let authority: string;
			try {
				const claims = await verifyServiceAuth(token, {
					serviceId: identity.serviceId,
					lxm: CHECK_USER_ACCESS_METHOD,
					resolveDid,
					now: now(),
				});
				authority = claims.iss;
			} catch (error) {
				const code = error instanceof ServiceAuthError ? error.code : "BadJwt";
				const message = error instanceof Error ? error.message : "service auth failed";
				// One line, because a refused authority is worth seeing and the limiter
				// bounds how many lines a caller can make.
				console.warn(`[managing-app] refused service auth: ${code}: ${message}`);
				return c.json({ error: code, message }, 401);
			}

			const decision = await authorize({ space, authority, userDid: user, access });
			return c.json({ authorized: decision.authorized }, 200, {
				"Cache-Control": "no-store",
			});
		});
}

/** The production router, with the network resolver and the database-backed gate. */
export const managingAppRoutes = createManagingAppRoutes();
