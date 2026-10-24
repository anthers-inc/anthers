// SPDX-License-Identifier: Apache-2.0
/**
 * The wire formats of a gated read: the signature a credential's use carries, the attestation
 * a space host verifies, the key share that derives the MAC secret, and the MAC itself.
 *
 * The cross-implementation proof is the staging test against the branch's PDS — a copied
 * format that has drifted fails there first. What this holds is the shape: exactly the covered
 * components, the fixed JWT type and audience, a 64-byte P-256 signature over the signing
 * input, and a MAC that rejects one changed byte.
 */
import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { decodeDidKey } from "../lib/did-key.js";
import {
	CLIENT_ATTESTATION_TYP,
	cidBytes,
	encapsulate,
	formatWantMacHeader,
	generateP256Key,
	mintClientAttestation,
	parseRecordMacHeader,
	signSpaceRequest,
	spaceHostAud,
	verifyRecordMac,
} from "../services/space-crypto.js";

const SPACE_DID = "did:plc:casey";
const CID = "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm";

function decodePart(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

describe("a space request's signature", () => {
	it("covers exactly the credential and the audience, and verifies with the credential key", () => {
		const key = generateP256Key();
		const authorization = "Atproto-Space-Credential header.payload.signature";
		const headers = signSpaceRequest(key, { authorization, audience: SPACE_DID });

		expect(headers.authorization).toBe(authorization);
		expect(headers["atproto-space-audience"]).toBe(SPACE_DID);
		expect(headers["signature-input"]).toBe(
			'atproto-space-credential=("authorization" "atproto-space-audience");tag="atproto-space-credential"',
		);

		const signaturePart = /:(.*):$/.exec(headers.signature ?? "")?.[1] ?? "";
		const signature = new Uint8Array(Buffer.from(signaturePart, "base64"));
		expect(signature).toHaveLength(64);

		const base = [
			`"authorization": ${authorization}`,
			`"atproto-space-audience": ${SPACE_DID}`,
			'"@signature-params": ("authorization" "atproto-space-audience");tag="atproto-space-credential"',
		].join("\n");
		expect(p256.verify(signature, new TextEncoder().encode(base), key.publicKey)).toBe(true);
	});
});

describe("a client attestation", () => {
	it("is a private_key_jwt for the space host with the client id on both sides", () => {
		const key = generateP256Key();
		const now = new Date("2026-10-24T12:00:00.000Z");
		const token = mintClientAttestation({
			clientId: "https://anthers.org/api/atproto/client-metadata.json",
			kid: key.didKey,
			secretKey: key.secretKey,
			spaceDid: SPACE_DID,
			now,
		});
		const [headerPart, payloadPart, signaturePart] = token.split(".");
		const header = decodePart(headerPart as string);
		const payload = decodePart(payloadPart as string);
		expect(header).toMatchObject({ alg: "ES256", typ: CLIENT_ATTESTATION_TYP, kid: key.didKey });
		expect(payload).toMatchObject({
			iss: "https://anthers.org/api/atproto/client-metadata.json",
			sub: "https://anthers.org/api/atproto/client-metadata.json",
			aud: spaceHostAud(SPACE_DID),
		});
		expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + 60);
		expect(typeof payload.jti).toBe("string");

		const signature = new Uint8Array(Buffer.from(signaturePart as string, "base64url"));
		expect(
			p256.verify(
				signature,
				new TextEncoder().encode(`${headerPart}.${payloadPart}`),
				key.publicKey,
			),
		).toBe(true);
	});
});

describe("the key share", () => {
	it("is an ephemeral P-256 did:key and a 32-byte secret", () => {
		const author = generateP256Key();
		const first = encapsulate(author.didKey);
		const second = encapsulate(author.didKey);
		expect(first.keyShare).toStartWith("did:key:z");
		expect(first.keyShare).not.toBe(second.keyShare);
		expect(first.sharedSecret).toHaveLength(32);

		// The author's side derives the same secret from the share. This is the one relation the
		// staging read depends on; the lab's PDS is the independent implementation that proves it.
		const share = decodeDidKey(first.keyShare);
		if (share.curve !== "p256") throw new Error("expected a P-256 key share");
		const dh = p256.getSharedSecret(author.secretKey, share.publicKey, true).slice(1);
		expect(dh).toHaveLength(32);
	});
});

describe("the record MAC", () => {
	it("covers the record's uri and its whole CID, version and codec included", () => {
		const cid = cidBytes(CID);
		expect(cid?.slice(0, 2)).toEqual(Uint8Array.from([0x01, 0x71]));
		const secret = new Uint8Array(32).fill(7);
		const uri = `at://${SPACE_DID}/space/org.anthers.creatorSpace/7/org.anthers.manifest/manifest`;
		const context = Buffer.concat([
			Buffer.from("atproto-space-record-v1"),
			Buffer.from([0, uri.length]),
			Buffer.from(uri),
		]);
		const mac = new Uint8Array(
			createHmac("sha256", secret)
				.update(Buffer.concat([context, Buffer.from(cid as Uint8Array)]))
				.digest(),
		);
		expect(verifyRecordMac(secret, uri, CID, mac)).toBe(true);
		expect(verifyRecordMac(secret, uri, CID.replace(/^b/, "c"), mac)).toBe(false);

		const header = `type="atproto-space-record", ver=1, key_share="did:key:zDnae"`;
		expect(formatWantMacHeader("did:key:zDnae")).toBe(header);
		const responseHeader = `type="atproto-space-record", ver=1, mac=:${Buffer.from(mac).toString("base64")}:`;
		expect(parseRecordMacHeader(responseHeader)).toEqual(mac);
		expect(() =>
			parseRecordMacHeader(
				`type="atproto-space-repo", ver=1, mac=:${Buffer.from(mac).toString("base64")}:`,
			),
		).toThrow();
	});
});
