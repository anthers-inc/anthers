// SPDX-License-Identifier: Apache-2.0
//
// Sign and verify the web-dist release asset with a plain Ed25519 signature.
//
// THIS SCRIPT DEFINES THE FORMAT CONTRACT the two consumer sides of the desktop's
// web build agree on. Everything about the format lives here; the mirrored readers
// (anthers-desktop's `scripts/resolve-web.ts` today, its Rust verifier later) and
// anthers-desktop's fixture test are copies, not owners, so format drift between
// the two fails the desktop's test rather than arriving as a mystery on release day.
//
// The two text forms, each two lines — a comment line, then standard base64:
//
//   web-dist.tar.gz.sig    — written beside the asset on every release:
//       untrusted comment: anthers web-dist Ed25519 signature
//       <base64 of the 64-byte Ed25519 signature over the file's exact bytes>
//   web-dist-signing.pub   — pinned in anthers-desktop:
//       untrusted comment: anthers web-dist Ed25519 signing key
//       <base64 of the 32-byte raw public key>
//
// The private key lives ONLY in this repository's Actions secrets, as
// `WEB_DIST_SIGNING_KEY`, in PKCS8 PEM form. It is not a file in either repository,
// and it is never passed on a command line or printed. Rotating it is: generate a
// new pair with `--generate`, replace the secret, and replace the desktop's `.pub`
// file — a single active key; if a consumer ever wants a ring, add it here first.
//
// The signature protects only integrity of the channel, not identity of the creator
// of a build: it proves the tarball came from a holder of the CI key, which is why
// the key's private half may never leave CI.

import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as cryptoSign,
	verify as cryptoVerify,
	type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SIG_COMMENT = "untrusted comment: anthers web-dist Ed25519 signature";
const PUB_COMMENT = "untrusted comment: anthers web-dist Ed25519 signing key";

// The 32-byte raw Ed25519 public key, wrapped in the fixed 12-byte SPKI prefix so
// node:crypto can build a KeyObject from raw bytes. Every Ed25519 SPKI is this
// exact shape, which keeps the pinned .pub a plain 32-byte key readable by a
// non-crypto consumer (the desktop's Rust side reads raw bytes, not DER).
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function generateKeyPair(): { privateKeyPem: string; publicKeyB64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12);
	return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyB64: raw.toString("base64") };
}

/** Decode the two-line .pub/.sig text form into its raw bytes, size-checked. */
export function decodeKeyBlock(text: string, expected: number, which: string): Buffer {
	const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	const data = lines[lines.length - 1];
	const raw = Buffer.from(data, "base64");
	if (raw.length !== expected) {
		throw new Error(`${which}: expected ${expected} bytes after base64 decoding, got ${raw.length}`);
	}
	return raw;
}

export function readPublicKey(pemOrText: string): KeyObject {
	const raw = decodeKeyBlock(pemOrText, 32, "public key");
	return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function signBuffer(message: Buffer, privateKeyPem: string): string {
	const key = createPrivateKey(privateKeyPem);
	if (key.asymmetricKeyType !== "ed25519") {
		throw new Error(`the signing key is ${key.asymmetricKeyType}, not an Ed25519 key`);
	}
	return cryptoSign(null, message, key).toString("base64");
}

export function writeSignature(sigB64: string, out: string): void {
	writeFileSync(out, `${SIG_COMMENT}\n${sigB64}\n`);
}

/**
 * True only when `message` verifies against the given .sig/.pub text forms with
 * Ed25519. Returns false — never throws — for a tampered or malformed signature of
 * the right size, because a verifier's answer is the verification, but rejects a
 * malformed block outright, since a wrong-format file is a different defect.
 */
export function verifyBuffer(message: Buffer, sigText: string, pubText: string): boolean {
	const sig = decodeKeyBlock(sigText, 64, "signature");
	const pubKey = readPublicKey(pubText);
	return cryptoVerify(null, message, pubKey, sig);
}

async function main(): Promise<0 | 1> {
	const args = process.argv.slice(2);
	if (args[0] === "--generate") {
		const out = args[args.indexOf("--generate") + 1];
		if (!out) {
			console.error("usage: sign-web-dist.ts --generate <private-key-out-path>");
			return 1;
		}
		const { privateKeyPem, publicKeyB64 } = generateKeyPair();
		writeFileSync(out, privateKeyPem, { mode: 0o600 });
		// Only the public half is printed — the private PEM stays in the file at
		// `out`, and the caller moves it into the Actions secret and then deletes it.
		console.log(`[key] wrote private key to ${out} (PKCS8 PEM); delete it once it is in the secret`);
		console.log(`[key] public key (raw base64) for the desktop's web-dist-signing.pub:\n${PUB_COMMENT}\n${publicKeyB64}`);
		return 0;
	}

	if (args[0] === "--verify") {
		const [file, sigPath, pubPath] = args.slice(1);
		if (!file || !sigPath || !pubPath) {
			console.error("usage: sign-web-dist.ts --verify <file> <file.sig> <web-dist-signing.pub>");
			return 1;
		}
		const message = Buffer.from(readFileSync(file));
		const ok = verifyBuffer(message, readFileSync(sigPath, "utf8"), readFileSync(pubPath, "utf8"));
		console.log(`[sig] ${ok ? "verified" : "FAILED TO VERIFY"}: ${file}`);
		return ok ? 0 : 1;
	}

	if (args[0] === "--self-verify") {
		// The release job's post-sign check: proves the signature is well-formed and
		// matches the secret, using the public half this process derives from it —
		// the cheapest thing that makes an empty or rotated-away secret loud.
		const file = args[1];
		if (!file) {
			console.error("usage: sign-web-dist.ts --self-verify <file>");
			return 1;
		}
		const secret = process.env.WEB_DIST_SIGNING_KEY;
		if (!secret) {
			console.error(
				"[sig] WEB_DIST_SIGNING_KEY is not set. It is an Actions secret in this repository holding the\n" +
					"      signing key's PKCS8 PEM — see this script's header. Without it the release asset is\n" +
					"      unsigned, and the desktop refuses unsigned builds.",
			);
			return 1;
		}
		const message = Buffer.from(readFileSync(file));
		const pubKey = createPublicKey(createPrivateKey(secret)).export({ type: "spki", format: "der" }) as Buffer;
		const ok = cryptoVerify(
			null,
			message,
			createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pubKey.subarray(12)]), format: "der", type: "spki" }),
			Buffer.from(decodeKeyBlock(readFileSync(`${file}.sig`, "utf8"), 64, "signature")),
		);
		console.log(`[sig] ${ok ? "self-verified against the secret's own public half" : "FAILED self-verify"}: ${file}`);
		return ok ? 0 : 1;
	}

	const file = args[0];
	if (!file) {
		console.error("usage: sign-web-dist.ts <file>   (or --verify, --self-verify, --generate)");
		return 1;
	}
	const secret = process.env.WEB_DIST_SIGNING_KEY;
	if (!secret) {
		console.error(
			"[sig] WEB_DIST_SIGNING_KEY is not set. It is an Actions secret in this repository holding the\n" +
				"      signing key's PKCS8 PEM — see this script's header. Without it the release asset is\n" +
				"      unsigned, and the desktop refuses unsigned builds.",
		);
		return 1;
	}
	writeSignature(signBuffer(Buffer.from(readFileSync(file)), secret), `${file}.sig`);
	console.log(`[sig] wrote ${file}.sig`);
	return 0;
}

if (import.meta.main) process.exitCode = (await main()) ?? 0;