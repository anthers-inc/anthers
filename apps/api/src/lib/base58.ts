// SPDX-License-Identifier: Apache-2.0
/**
 * Base58btc, the encoding multibase's `z` prefix names.
 *
 * ⚠️ **Leading zero bytes are significant and the arithmetic alone loses them.** Every zero
 * byte becomes a literal `1` before the encoded digits, which is why a public key's first
 * byte matters to the length of the string. A decoder that skips the rule produces a shorter
 * key that still looks like a key; the one that matters, a `did:key:`, resolves to nothing.
 */

/** The base58btc alphabet — Bitcoin's ordering, which is what multibase `z` means. */
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58btc string, or null when it holds a character the alphabet does not. */
export function base58Decode(input: string): Uint8Array | null {
	let n = 0n;
	for (const ch of input) {
		const index = BASE58.indexOf(ch);
		if (index < 0) return null;
		n = n * 58n + BigInt(index);
	}
	const bytes: number[] = [];
	while (n > 0n) {
		bytes.unshift(Number(n % 256n));
		n /= 256n;
	}
	for (const ch of input) {
		if (ch !== "1") break;
		bytes.unshift(0);
	}
	return Uint8Array.from(bytes);
}

/** Encode bytes as base58btc, including the leading-zero rule the decoder depends on. */
export function base58Encode(bytes: Uint8Array): string {
	let n = 0n;
	for (const byte of bytes) n = (n << 8n) | BigInt(byte);
	let out = "";
	while (n > 0n) {
		const remainder = Number(n % 58n);
		n /= 58n;
		out = BASE58[remainder] + out;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		out = `1${out}`;
	}
	return out;
}
