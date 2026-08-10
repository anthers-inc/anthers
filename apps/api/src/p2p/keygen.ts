// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generate the hub's P2P token-signing keypair (Ed25519, per 45.05).
 *
 * Usage: bun run p2p:keygen
 *
 * Prints both halves and exits. Nothing is written to disk or to the database on purpose —
 * a keygen that helpfully installs its own output is one `--force` away from rotating a
 * live key, and rotation invalidates every token in flight. Copy the private half into
 * `P2P_HUB_PRIVATE_KEY` yourself: `.env` for dev, and for production the App Platform
 * secret (`doctl apps update <app-id> --spec`, never a push — pushing to `release`
 * deploys code and never the committed spec).
 *
 * The public half is printed for reference only; it does not need to be stored anywhere.
 * `/api/p2p/pubkey` derives it from the private key on demand, so the two cannot drift.
 */
import { generateKeyPair, getPublicKeyB64 } from "./token.js";

const { privateKeyB64, publicKeyB64 } = await generateKeyPair();

console.log("");
console.log("P2P hub signing keypair (Ed25519)");
console.log("");
console.log("  Private — set as P2P_HUB_PRIVATE_KEY, never commit it:");
console.log(`    ${privateKeyB64}`);
console.log("");
console.log("  Public — served at /api/p2p/pubkey, shown here for reference only:");
console.log(`    ${publicKeyB64}`);
console.log("");

// Round-trip the key we just printed rather than trusting that it imports. A malformed
// private half fails at the first token mint otherwise, which is a long way from here.
process.env.P2P_HUB_PRIVATE_KEY = privateKeyB64;
const derived = await getPublicKeyB64();
if (derived !== publicKeyB64) {
	console.error("Key verification FAILED — the private key does not derive its own public half.");
	process.exit(1);
}
console.log("Verified: the private key derives the public half above.");
console.log("");
