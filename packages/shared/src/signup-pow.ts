// SPDX-License-Identifier: Apache-2.0
/**
 * The signup proof-of-work solver — the browser half of the hashcash gate on
 * `POST /auth/signup/begin`.
 *
 * The server issues `{ id, challenge, difficulty }` (`GET /auth/signup/challenge`);
 * this grinds SHA-256 of `challenge + nonce` over nonce = 0, 1, 2, … until the digest
 * carries `difficulty` leading hex zeros, and returns the winning nonce. The server
 * re-hashes once to verify — see `services/signup-challenges.ts` on the API side, which
 * owns the rules; the scheme and the difficulty check are the same shape on both sides
 * on purpose, so a change to one has to be a change to both to keep working.
 *
 * 🚨 **Pure function, WebCrypto only.** No DOM, no fetch, no state — the page fetches the
 * challenge and posts the answer, and this module is the grind between them, so the e2e
 * and unit layers use it directly rather than a re-implementation that could drift. There
 * is deliberately no JS SHA-256 fallback: this is not a compatibility surface, and every
 * browser that runs the app has `crypto.subtle.digest` (Bun has it too, which is what
 * lets the API's unit suites solve real puzzles when they want to).
 *
 * ⚠️ **`await` per hash is the design, not laziness.** A tight synchronous loop would
 * freeze the page for the whole grind (about a second at difficulty 4, much longer on a
 * slow phone at 5), while awaiting the digest yields to the event loop between hashes
 * and keeps the button's "Checking you're a person…" state animating.
 */

/** Lowercase hex SHA-256 of a string, via WebCrypto. */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Whether a digest carries `difficulty` leading hex zeros.
 *
 * 🚨 **Counted on the hex string, and `difficulty` of them, nothing looser.** The classic
 * off-by-one here — accepting `difficulty - 1` zeros, or testing bits — halves the cost
 * a script pays per protection level, so the check is one line and one place, shared by
 * the browser solver and the server's verify.
 */
export function meetsDifficulty(digestHex: string, difficulty: number): boolean {
	if (difficulty <= 0) return true;
	return digestHex.startsWith("0".repeat(difficulty));
}

/**
 * Grind nonce = 0, 1, 2, … until the digest of `challenge + nonce` carries `difficulty`
 * leading hex zeros, and return the winning nonce as a string (the honest shape of a
 * counter; callers that must post an integer parse it once, at the boundary).
 */
export async function solve(challenge: string, difficulty: number): Promise<string> {
	if (difficulty <= 0) return "0";
	const zeros = "0".repeat(difficulty);
	for (let nonce = 0; ; nonce++) {
		const digest = await sha256Hex(`${challenge}${nonce}`);
		if (digest.startsWith(zeros)) return String(nonce);
	}
}
