// SPDX-License-Identifier: Apache-2.0
/**
 * A placeholder DID for an account made by a seed or a test fixture rather than by signup.
 *
 * `users.atproto_did` is NOT NULL because every real account holds an identity, and signup is
 * the only thing that issues one. Seeds and fixtures write accounts directly, so they need a
 * value that satisfies the column without pretending to be an identity anybody holds.
 *
 * 🚨 **This is a stopgap, not a design.** It exists until the wiki task *Replace seeded test
 * data with sanitized dumps from production* decides how a test gets an account, and it should
 * be deleted there rather than built on.
 *
 * 🛑 **Nothing may resolve or publish to one of these.** The value is shaped like a
 * `did:plc` so the column and anything that parses a DID accept it, but no PLC directory holds
 * it and no repository exists behind it. A path that would write a record, look up a handle or
 * fetch a DID document for a fixture account must stop before it reaches the network.
 */

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh `did:plc:` followed by 24 lowercase base32 characters, unique per call. */
export function fixtureDid(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	let id = "";
	for (const byte of bytes) id += BASE32[byte % 32];
	return `did:plc:${id}`;
}
