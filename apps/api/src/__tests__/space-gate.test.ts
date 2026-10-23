// SPDX-License-Identifier: Apache-2.0
/**
 * The space gate's policy, against real rows.
 *
 * The staging test proves the protocol path — a space authority, a service-auth token, and a
 * credential issued or refused. This proves the part the protocol never sees: which Work a
 * space names, who owns it, and what `resolveAccess` says about the reader. The cases are the
 * product's existing distinctions rather than new ones — owner, purchase, unpublished — plus
 * the two the network adds, a space that is not the creator's and a reader with no account.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { authorizeSpaceAccess, parseCreatorSpace } from "../services/space-gate.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

/** Purchases outlive their Work (`set null`), so the fixture deletes them itself. */
const intentIds: string[] = [];
afterAll(async () => {
	for (const id of intentIds) {
		await db.delete(purchases).where(eq(purchases.stripePaymentIntentId, id));
	}
});

let run = 0;
async function purchase(buyerId: number, workId: number): Promise<void> {
	const id = `pi_gate_${Date.now()}_${run++}`;
	intentIds.push(id);
	await db.insert(purchases).values({
		buyerId,
		workId,
		type: "digital",
		amount: "5.00",
		processingFee: "0.45",
		salesTax: "0.00",
		creatorEarnings: "5.00",
		stripePaymentIntentId: id,
		status: "completed",
	});
}

const GATED = [{ threshold: 0, allow: false, price: "5.00" }];

describe("parseCreatorSpace", () => {
	it("reads the authority and the Work's public id", () => {
		expect(parseCreatorSpace("at://did:plc:creator/space/org.anthers.creatorSpace/42")).toEqual({
			authority: "did:plc:creator",
			publicId: 42,
		});
	});

	it("refuses anything that is not one of our creator spaces", () => {
		expect(parseCreatorSpace("at://did:plc:creator/space/org.anthers.userSpace/42")).toBeNull();
		expect(
			parseCreatorSpace("at://did:plc:creator/space/org.anthers.creatorSpace/not-a-number"),
		).toBeNull();
		expect(parseCreatorSpace("at://did:plc:creator/space/org.anthers.creatorSpace/0")).toBeNull();
		expect(
			parseCreatorSpace("at://did:plc:creator/space/org.anthers.creatorSpace/1/extra"),
		).toBeNull();
		expect(parseCreatorSpace("https://example.com/space")).toBeNull();
	});
});

describe("authorizeSpaceAccess", () => {
	it("authorizes the owner, an entitled reader and the refusals in between", async () => {
		const creator = await createAccount(`gate-creator-${Date.now().toString(36)}`);
		const reader = await createAccount(`gate-reader-${Date.now().toString(36)}`);
		const outsider = await createAccount(`gate-outsider-${Date.now().toString(36)}`);
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: "The gated one",
			access: GATED,
		});
		await purchase(reader.userId, work.id);
		const space = `at://${creator.did}/space/org.anthers.creatorSpace/${work.publicId}`;

		const owner = await authorizeSpaceAccess({
			space,
			authority: creator.did,
			userDid: creator.did,
			access: "read",
		});
		expect(owner).toEqual({ authorized: true, reason: "owner" });

		const entitled = await authorizeSpaceAccess({
			space,
			authority: creator.did,
			userDid: reader.did,
			access: "read",
		});
		expect(entitled).toEqual({ authorized: true, reason: "entitled" });

		const refused = await authorizeSpaceAccess({
			space,
			authority: creator.did,
			userDid: outsider.did,
			access: "read",
		});
		expect(refused).toEqual({ authorized: false, reason: "not-entitled" });

		const stranger = await authorizeSpaceAccess({
			space,
			authority: creator.did,
			userDid: "did:plc:nobodyhasthisaccount",
			access: "read",
		});
		expect(stranger).toEqual({ authorized: false, reason: "unknown-user" });

		const notTheAuthority = await authorizeSpaceAccess({
			space,
			authority: outsider.did,
			userDid: reader.did,
			access: "read",
		});
		expect(notTheAuthority).toEqual({ authorized: false, reason: "not-the-authority" });

		const someoneElsesSpace = await authorizeSpaceAccess({
			space: `at://${outsider.did}/space/org.anthers.creatorSpace/${work.publicId}`,
			authority: outsider.did,
			userDid: reader.did,
			access: "read",
		});
		expect(someoneElsesSpace).toEqual({ authorized: false, reason: "unknown-space" });

		// The write question is asked about a member's own repo in a shared space. A creator
		// space has no member writers: the creator writes, and nobody else does.
		const readerWrite = await authorizeSpaceAccess({
			space,
			authority: creator.did,
			userDid: reader.did,
			access: "write",
		});
		expect(readerWrite).toEqual({ authorized: false, reason: "not-entitled" });
		const ownerWrite = await authorizeSpaceAccess({
			space,
			authority: creator.did,
			userDid: creator.did,
			access: "write",
		});
		expect(ownerWrite).toEqual({ authorized: true, reason: "owner" });
	});

	it("keeps a private Work out of reach even for a reader who paid for it", async () => {
		const creator = await createAccount(`gate-private-creator-${Date.now().toString(36)}`);
		const reader = await createAccount(`gate-private-reader-${Date.now().toString(36)}`);
		const work = await insertWork({
			creatorId: creator.userId,
			type: "text",
			title: "Still a draft",
			visibility: "private",
			access: GATED,
		});
		await purchase(reader.userId, work.id);

		const decision = await authorizeSpaceAccess({
			space: `at://${creator.did}/space/org.anthers.creatorSpace/${work.publicId}`,
			authority: creator.did,
			userDid: reader.did,
			access: "read",
		});
		expect(decision).toEqual({ authorized: false, reason: "unreleased" });
	});

	it("refuses a user space named at this gate", async () => {
		const creator = await createAccount(`gate-userspace-${Date.now().toString(36)}`);
		const decision = await authorizeSpaceAccess({
			space: `at://${creator.did}/space/org.anthers.userSpace/1`,
			authority: creator.did,
			userDid: creator.did,
			access: "read",
		});
		expect(decision).toEqual({ authorized: false, reason: "not-a-creator-space" });
	});
});
