// SPDX-License-Identifier: Apache-2.0
/**
 * The ATProto session at rest.
 *
 * The row carries the access token, the refresh token and the DPoP private key, so a
 * database dump or a read-only SQL credential is repository write access unless the value
 * is sealed. The store writes `v1.<iv>.<tag>.<ciphertext>` and opens it on the way back; a
 * row written before the change stays readable as a plain object.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { atprotoSessions } from "@anthers/db/schema";
import { JoseKey } from "@atproto/jwk-jose";
import { eq } from "drizzle-orm";
import { oauthSessionStore } from "../services/atproto-client";

const DID = `did:plc:session-seal-${crypto.randomUUID().slice(0, 8)}`;
const KEY = "HOSTED_ACCOUNT_KEY";
let previous: string | undefined;

beforeAll(() => {
	previous = process.env[KEY];
	process.env[KEY] = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
});

afterAll(async () => {
	await db.delete(atprotoSessions).where(eq(atprotoSessions.did, DID));
	if (previous === undefined) delete process.env[KEY];
	else process.env[KEY] = previous;
});

describe("the ATProto session store", () => {
	it("seals the session at rest and returns it whole", async () => {
		const accessJwt = `access-${crypto.randomUUID()}`;
		const refreshJwt = `refresh-${crypto.randomUUID()}`;
		const dpopKey = await JoseKey.generate(["ES256"]);

		await oauthSessionStore.set(DID, { accessJwt, refreshJwt, dpopKey });

		const [row] = await db
			.select({ session: atprotoSessions.session })
			.from(atprotoSessions)
			.where(eq(atprotoSessions.did, DID));
		expect(typeof row.session).toBe("string");
		const stored = row.session as string;
		expect(stored.startsWith("v1.")).toBe(true);
		expect(stored).not.toContain(accessJwt);
		expect(stored).not.toContain(refreshJwt);

		const opened = await oauthSessionStore.get(DID);
		expect(opened?.accessJwt).toBe(accessJwt);
		expect(opened?.refreshJwt).toBe(refreshJwt);
		expect(opened?.dpopKey).toBeDefined();
	});
});
