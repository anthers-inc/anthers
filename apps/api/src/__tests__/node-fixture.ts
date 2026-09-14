// SPDX-License-Identifier: Apache-2.0
/**
 * Telling a suite which domain a stubbed identity server issues handles under.
 *
 * The hub asks the server itself, through `describeServer`, and remembers the answer for the life
 * of the process (`hostedHandleSuffix`). A suite that stubs the server's other answers per test
 * would otherwise have its first stub asked that question too — and whether a given test saw the
 * call would depend on the order the tests ran in. `learnHandleDomain` answers it once, up front,
 * so every stub after it is asked only what its test is about.
 */
import { hostedHandleSuffix } from "../services/hosted-accounts.js";

/** A fetch that answers `describeServer` with one handle domain, and refuses everything else. */
export function describingNode(domain: string): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.endsWith("/xrpc/com.atproto.server.describeServer")) {
			throw new Error(`describingNode answers describeServer only, not ${url}`);
		}
		return new Response(JSON.stringify({ availableUserDomains: [`.${domain}`] }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

/** Have this process learn that the server at `url` issues handles under `domain`. */
export async function learnHandleDomain(url: string, domain: string): Promise<void> {
	const before = process.env.HOSTED_PDS_URL;
	process.env.HOSTED_PDS_URL = url;
	try {
		const learned = await hostedHandleSuffix({ fetchImpl: describingNode(domain) });
		if (learned !== domain)
			throw new Error(`expected to learn ${domain} for ${url}, got "${learned}"`);
	} finally {
		if (before === undefined) delete process.env.HOSTED_PDS_URL;
		else process.env.HOSTED_PDS_URL = before;
	}
}
