// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sealing a short secret so that a copy of the database is not a copy of the credentials.
 *
 * ⭐ **The threat this addresses is narrow and worth naming, because encryption at rest is
 * often claimed to do more than it does.** The key lives in the application's environment and
 * the ciphertext lives in Postgres, so anything that can read one cannot necessarily read the
 * other: a database dump, a backup file, a replica handed to a contractor, or a read-only SQL
 * credential all yield ciphertext and nothing else. It does **not** protect against somebody
 * who can run code in the API, and nothing here pretends otherwise.
 *
 * 🚨 **AES-256-GCM, so a tampered value fails to open rather than opening as something
 * else.** The authentication tag is what makes that true, and it is why this is not
 * `aes-256-cbc`: an unauthenticated cipher lets whoever can write the column choose what the
 * plaintext decrypts to, which for a stored password means choosing a password.
 *
 * The sealed form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is there
 * so that a future key rotation can be told apart from a value written today, rather than
 * being guessed at from the length.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
/** 96 bits, which is the IV length GCM is specified for and the only one worth using. */
const IV_BYTES = 12;

/**
 * The key, read at use rather than at import.
 *
 * ⚠️ **Read lazily on purpose.** A module that throws at import time takes the whole API down
 * on boot over a feature nobody has switched on — the failure mode `.do/app.yaml`'s own note
 * about unset secrets warns about. Everything that would use this checks
 * {@link secretBoxConfigured} first and simply does not offer the feature.
 */
function key(): Buffer {
	const raw = process.env.HOSTED_ACCOUNT_KEY?.trim();
	if (!raw) throw new Error("HOSTED_ACCOUNT_KEY is not set");
	// Accepts hex or base64; both are ways people paste 32 bytes, and guessing wrong would
	// produce a key of the wrong length rather than a wrong key, which is caught below.
	const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
	if (bytes.length !== 32) {
		throw new Error(`HOSTED_ACCOUNT_KEY must be 32 bytes; got ${bytes.length}`);
	}
	return bytes;
}

/** Whether a usable key is present. Checked before offering anything that would need one. */
export function secretBoxConfigured(): boolean {
	try {
		key();
		return true;
	} catch {
		return false;
	}
}

/** Seal a secret. The result is safe to store and useless without the key. */
export function seal(plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key(), iv);
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, b64(iv), b64(tag), b64(body)].join(".");
}

/**
 * Open a sealed secret.
 *
 * Throws on anything that is not exactly what {@link seal} wrote with this key — a wrong key,
 * a truncated value, a changed byte. That is the point of the authentication tag, and a caller
 * that would rather have `null` should catch rather than have this soften.
 */
export function open(sealed: string): string {
	const parts = sealed.split(".");
	if (parts.length !== 4 || parts[0] !== VERSION) {
		throw new Error("sealed value is not in the expected form");
	}
	const [, iv, tag, body] = parts;
	const decipher = createDecipheriv(ALGORITHM, key(), unb64(iv));
	decipher.setAuthTag(unb64(tag));
	return Buffer.concat([decipher.update(unb64(body)), decipher.final()]).toString("utf8");
}

function b64(buf: Buffer): string {
	return buf.toString("base64url");
}

function unb64(value: string): Buffer {
	return Buffer.from(value, "base64url");
}
