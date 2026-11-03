// SPDX-License-Identifier: Apache-2.0
/**
 * Where the dev web-build harness page exists, and where it must not.
 *
 * The page is a checkout's tool: it lists a local directory of builds and plays one through
 * the API's dev delivery route. `20.01 Running It Locally` says a production build has no
 * such page, and this is the predicate `serve.ts` asks before serving it.
 */
import { describe, expect, it } from "bun:test";
import { servesDevBuildPage } from "./dev-build-page.js";

describe("the dev web-build page", () => {
	it("is served by a browser session's preview, which names its local API port", () => {
		expect(servesDevBuildPage({ API_PORT: "4173" })).toBe(true);
	});

	it("is not served by a deployed web component", () => {
		// The `web` service's environment from `.do/app.yaml`: a private-network API origin, a
		// public site origin, and no local port at all.
		expect(
			servesDevBuildPage({
				API_ORIGIN: "http://api",
				SITE_ORIGIN: "https://anthers.org",
			}),
		).toBe(false);
		// 🚨 A missing variable must not be the thing that opens the door. `isDevCheckout()`
		// — the API's container check — is TRUE in this component, because the web service is
		// a source deploy and the whole repository is present at run time. This is the check
		// that differs between the two.
		expect(servesDevBuildPage({})).toBe(false);
		expect(servesDevBuildPage({ API_PORT: "not-a-port" })).toBe(false);
	});
});
