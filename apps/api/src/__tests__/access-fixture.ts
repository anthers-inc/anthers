// SPDX-License-Identifier: Apache-2.0
/**
 * The two calls a signed-in download now takes: mint the grant, then present it.
 *
 * ⭐ **One helper, so every suite exercises the same flow.** Delivery requires a grant for a
 * signed-in request, and a suite that hand-rolled the header could as easily hand-roll the
 * route into a state the web client never produces. A share-link request is exempt (its token
 * is the credential), so suites testing shares call the route without this.
 */
import app from "../index";

const ORIGIN = "http://localhost:3000";

function request(path: string, init: RequestInit): Promise<Response> {
	return Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, init)));
}

/**
 * Ask for a grant for one asset, or null when the caller is not entitled to one.
 *
 * A null is not an error: the suites that assert a refusal want the download route's own
 * answer, and a denied grant is the first half of it.
 */
export async function grantForAsset(
	cookie: string,
	workId: number,
	assetId: number,
): Promise<string | null> {
	const response = await request(`/api/content/works/${workId}/grant`, {
		method: "POST",
		headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json" },
		body: JSON.stringify({ assetId }),
	});
	if (!response.ok) return null;
	const body = (await response.json()) as { grant?: string };
	return body.grant ?? null;
}

/**
 * A purchaser's download: mint a grant for this file, then send it.
 *
 * When the grant is refused the download is still sent, without a token, because the
 * route's answer is what a suite asserting a refusal is about.
 */
export async function downloadAsset(
	cookie: string,
	workId: number,
	assetId: number,
	options: { headers?: Record<string, string> } = {},
): Promise<Response> {
	const grant = await grantForAsset(cookie, workId, assetId);
	return request(`/api/content/works/${workId}/assets/${assetId}/download`, {
		method: "POST",
		headers: {
			Origin: ORIGIN,
			Cookie: cookie,
			...(grant ? { "X-Anthers-Grant": grant } : {}),
			...(options.headers ?? {}),
		},
	});
}
