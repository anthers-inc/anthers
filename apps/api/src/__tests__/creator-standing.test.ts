// SPDX-License-Identifier: Apache-2.0
/**
 * Who counts as a creator, at the boundaries that make the answer mean something.
 *
 * 🚨 **This replaces `@anthers/shared/verified-creator`, which asked the wrong question**
 * (Parker, 2026-10-24). That predicate wanted creator mode **and a released Work**, so a
 * creator who published posts and had released nothing was not one, and the Discord creators
 * channels were gated on the same thing. What a claim of creator standing needs is completed
 * setup, which is what `services/creator-standing` now answers.
 *
 * ⚠️ **Every case here is a rule about an absence**, so nothing else in the repository can
 * catch a regression: a listing that quietly gains a mode-on account still returns 200 with a
 * plausible body. Break the predicate on purpose before trusting this file — stubbed to
 * `true`, the four false cases must fail; stubbed to `false`, the two true ones must.
 *
 * The last case is the one the old predicate would have failed, and the reason this file
 * exists at all.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, stripeAccounts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { isCreator, isCreatorWhere } from "../services/creator-standing";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);

let plain: FixtureAccount;
let modeOnly: FixtureAccount;
let heldPayouts: FixtureAccount;
let modeOffWithPayouts: FixtureAccount;
let creator: FixtureAccount;
let postOnly: FixtureAccount;

/**
 * What a listing sees, asked through the SQL predicate rather than the single-row helper.
 *
 * Both forms are read for every account in {@link agrees}, because a listing that includes
 * somebody the check excludes is the drift no other test would notice — the page still
 * renders, with one extra row.
 */
async function listed(userId: number): Promise<boolean> {
	const [row] = await db
		.select({ isCreator: isCreatorWhere(users.id) })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return Boolean(row?.isCreator);
}

async function agrees(account: FixtureAccount, expected: boolean) {
	expect(await isCreator(account.userId)).toBe(expected);
	expect(await listed(account.userId)).toBe(expected);
}

beforeAll(async () => {
	plain = await createAccount(`cs_plain_${run}`);
	modeOnly = await createAccount(`cs_mode_${run}`, { fields: { creatorMode: true } });

	// Onboarding finished, but Stripe is holding the account: it cannot be sent money, so it
	// is not a creator — the same reason `canBePaid` requires both flags.
	heldPayouts = await createAccount(`cs_held_${run}`, { fields: { creatorMode: true } });
	await db.insert(stripeAccounts).values({
		userId: heldPayouts.userId,
		stripeAccountId: `acct_test_${heldPayouts.userId}_${run}`,
		onboardingComplete: true,
		payoutsEnabled: false,
		chargesEnabled: true,
	});

	// The other direction: fully payable, but the person turned the Studio off, which is them
	// saying they are not a creator here. A Stripe account does not overrule that.
	modeOffWithPayouts = await createAccount(`cs_off_${run}`);
	await enablePayoutsFor(modeOffWithPayouts.userId);
	await db.update(users).set({ creatorMode: false }).where(eq(users.id, modeOffWithPayouts.userId));

	creator = await createAccount(`cs_creator_${run}`);
	await enablePayoutsFor(creator.userId);

	// ⭐ The case the retired predicate got wrong: a set-up creator who publishes posts and
	// has released no Work at all.
	postOnly = await createAccount(`cs_post_${run}`);
	await enablePayoutsFor(postOnly.userId);
	await db.insert(posts).values({
		creatorId: postOnly.userId,
		title: "A published note",
		slug: `cs-post-${run}`,
		publicId: 950_000_000 + (Number.parseInt(run, 16) % 800_000),
		isPublished: true,
	});
}, DB_SETUP_TIMEOUT);

describe("creator standing", () => {
	it("is not a creator without creator mode, even with completed payouts", async () => {
		await agrees(modeOffWithPayouts, false);
	});

	it("is not a creator with creator mode alone", async () => {
		await agrees(modeOnly, false);
	});

	it("is not a creator while Stripe is holding the payout account", async () => {
		await agrees(heldPayouts, false);
	});

	it("is not a creator for an ordinary account", async () => {
		await agrees(plain, false);
	});

	it("is a creator once creator mode and completed payout setup are both true", async () => {
		await agrees(creator, true);
	});

	it("is a creator with a published post and no released Work", async () => {
		await agrees(postOnly, true);
	});
});
