// SPDX-License-Identifier: Apache-2.0
/**
 * The Bluesky door's landing requirement, and the refusal that says so when it cannot be met.
 *
 * The OAuth client a checkout talks with is a loopback client — its identity carries its
 * parameters in the client-id query string, so the authorization server never fetches anything
 * — and that form's redirect is spec-forced to a literal loopback address. The one the client
 * metadata declares lands at `http://127.0.0.1:8000`, where `make dev` puts the API only when it
 * runs without the name proxy: behind portless the API listens on the proxy's allocated port.
 * The round trip as written today therefore dies AFTER consent, at a connection refusal on a
 * port nobody answers — the person walked the whole ceremony and then hit a dead address.
 *
 * ⚠️ **Why the named world cannot host this redirect instead.** Two paths exist and both are
 * closed: a discoverable https client (the production shape, whose redirect may name the proxy's
 * origin) must be fetched by the authorization server — the private network's server sits inside
 * a Docker container the name proxy, which binds loopback only, does not reach. And the loopback
 * redirect cannot carry its cookies into the jar the SPA's API calls use, because the API's
 * cookies are host-scoped and `127.0.0.1` is a different host (`rpc.ts`'s incident map). So the
 * round trip rides the loopback pair, and this checkout's portless session refuses the door
 * rather than letting it die mid-ceremony. The loopback pair is where the escape hatch
 * (`PORTLESS=0 bun run dev`) and every browser test session already put the API.
 *
 * ⚠️ **The probe answers "is anything live there", never "is it ours".** A listener on
 * `:8000` that serves the metadata path with a 200 passes the check and the door opens — but if
 * that listener is another checkout's, the callback it receives carries a request-uri it cannot
 * resolve, and its own refusal page is what the person lands on. The failure is loud and
 * pointed at the right question; it is just not silent, which is the only requirement.
 */

/** The URL the dev client metadata's redirect lands its browser on. */
export const DOOR_LANDING = "http://127.0.0.1:8000/api/atproto/client-metadata.json";

/**
 * The refusal for a Bluesky round trip this session cannot land, or undefined when the door
 * may open.
 */
export async function blueskyDoorRefusalFor(
	env: Record<string, string | undefined>,
	answers: (url: string) => Promise<boolean>,
): Promise<string | undefined> {
	// The guard's shape is the proxy's presence, not a mode: PORTLESS_URL names an origin only
	// the portless CLI sets, and the one that does not answer is the redirect's own landing.
	if (!env.PORTLESS_URL) return undefined;
	const live = await answers(DOOR_LANDING);
	if (live) return undefined;
	return (
		"The Bluesky round trip lands at its loopback address (127.0.0.1:8000), where no server is " +
		"listening: this session runs behind the name proxy, which serves the API at a named URL " +
		"only. Walk the door with `PORTLESS=0 bun run dev`, which puts the API back on :8000 for " +
		"the ceremony, or exercise it in a browser test run, which starts an API of its own on a " +
		"free port."
	);
}

/** The route's call, against this process's environment. */
export function blueskyDoorRefusal(
	env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
	return blueskyDoorRefusalFor(env, (url) =>
		fetch(url, { signal: AbortSignal.timeout(2000) })
			.then((res) => res.ok)
			.catch(() => false),
	);
}
