/**
 * Shield by Project Arachnid — the HTTP client, and the only place a detection vendor is
 * spoken to over the network.
 *
 * Hand-rolled against the published OpenAPI specification rather than taking the official
 * TypeScript SDK, on the same reasoning as `standard-webhooks.ts`: the surface we use is
 * **one endpoint with Basic auth**, the SDK is not published to npm at all (it would be a
 * git dependency), and this sits on the child-safety path where a dependency nobody can
 * audit quickly is a poor trade for a `fetch` call.
 *
 * ── The one endpoint we call ────────────────────────────────────────────────────────
 *
 * `POST /v1/pdq` takes base64-encoded PDQ hashes and answers per hash. **No media and no
 * URL ever leaves Anthers** — wiki 40.12 § *What leaves Anthers is a hash, never the
 * media*.
 *
 * 🛑 **`POST /v1/media/submit` must never be called from this file or any other.** It
 * uploads a user's file for Project Arachnid analysts to classify **and retain**, which is
 * a permanent disclosure of somebody's upload to a third party's corpus rather than a
 * scan. Its name reads like an ordinary submission and its effect is not, which is exactly
 * what makes it the most consequential mistake available in this integration. The other
 * media endpoints (`/v1/media`, `/v1/url`) are simply not part of the design.
 *
 * ⚠️ **Match Data must never reach an agent.** § 6(b) and § 6(c) of the Shield terms make
 * generative-AI use of what this returns a prohibited use of the service, and § 13(e)
 * forbids retaining it past the purpose it was given for. Everything this module returns
 * is therefore handled as `VendorMatch` and kept out of the operator queue and the
 * moderation log — see `services/quarantine.ts`.
 */

const SHIELD_BASE_URL = "https://shield.projectarachnid.com";

/**
 * What Shield can say about a hash. **Four values, not three.**
 *
 * 🚨 `test` exists so an integration can be exercised without real material, which means a
 * naive *"anything that is not `no-known-match` is a hit"* check **quarantines on the
 * vendor's own test fixture**. Every value is handled explicitly for that reason.
 */
export type ShieldClassification = "csam" | "harmful-abusive-material" | "test" | "no-known-match";

/** Whether the corpus entry was hit exactly or by perceptual proximity. */
export type ShieldMatchType = "exact" | "near";

export interface ShieldScannedHash {
	classification: ShieldClassification;
	/** Absent — not empty — when nothing matched. */
	matchType: ShieldMatchType | null;
}

export interface ShieldCredentials {
	username: string;
	password: string;
}

/** Reads the credential pair, or null when it is not configured. */
export function shieldCredentials(): ShieldCredentials | null {
	const username = process.env.ARACHNID_SHIELD_USERNAME?.trim() ?? "";
	const password = process.env.ARACHNID_SHIELD_PASSWORD?.trim() ?? "";
	if (!username || !password) return null;
	return { username, password };
}

/** PDQ hashes travel to Shield base64-encoded, not as the hex we compute and store. */
export function pdqHexToBase64(hex: string): string {
	return Buffer.from(hex, "hex").toString("base64");
}

export class ShieldError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ShieldError";
	}
}

/**
 * Ask Shield about a batch of PDQ hashes.
 *
 * Returns a map keyed by the **hex** hash that went in, so a caller never has to reason
 * about the base64 the wire uses. A hash Shield does not answer for is simply absent from
 * the map, which the caller must treat as "not answered" rather than "no match" — those
 * mean opposite things when deciding whether a scan is complete.
 *
 * ⚠️ **Throws rather than returning a null-ish answer on failure.** A vendor being
 * unreachable is not the same as a vendor saying nothing matched, and the difference has
 * to survive all the way to the caller: one leaves the scan owed, the other completes it.
 */
export async function scanPdqHashes(
	hexHashes: string[],
	credentials: ShieldCredentials,
	options: { signal?: AbortSignal; baseUrl?: string } = {},
): Promise<Map<string, ShieldScannedHash>> {
	const out = new Map<string, ShieldScannedHash>();
	if (hexHashes.length === 0) return out;

	const byBase64 = new Map(hexHashes.map((hex) => [pdqHexToBase64(hex), hex]));
	const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");

	let response: Response;
	try {
		response = await fetch(`${options.baseUrl ?? SHIELD_BASE_URL}/v1/pdq`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
			body: JSON.stringify({ hashes: [...byBase64.keys()] }),
			signal: options.signal,
		});
	} catch (cause) {
		throw new ShieldError(`Shield unreachable: ${(cause as Error).message}`);
	}

	if (!response.ok) {
		throw new ShieldError(`Shield returned ${response.status}`, response.status);
	}

	const body = (await response.json()) as {
		scanned_hashes?: Record<string, { classification?: string; match_type?: string | null }>;
	};

	for (const [base64, scanned] of Object.entries(body.scanned_hashes ?? {})) {
		const hex = byBase64.get(base64);
		// A key we did not send is not ours to interpret. Dropping it is deliberate: the
		// map is keyed by what the caller asked about, and inventing an entry for something
		// unasked would let a vendor's answer attach itself to the wrong upload.
		if (!hex) continue;
		const classification = scanned.classification;
		if (!isClassification(classification)) {
			throw new ShieldError(`Shield returned an unknown classification: ${classification}`);
		}
		out.set(hex, {
			classification,
			matchType:
				scanned.match_type === "exact" || scanned.match_type === "near" ? scanned.match_type : null,
		});
	}
	return out;
}

function isClassification(value: unknown): value is ShieldClassification {
	return (
		value === "csam" ||
		value === "harmful-abusive-material" ||
		value === "test" ||
		value === "no-known-match"
	);
}
