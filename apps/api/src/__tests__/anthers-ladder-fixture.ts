// SPDX-License-Identifier: Apache-2.0
/**
 * The Anthers Badge ladder, seeded into a test session exactly as `make dev`'s
 * `db:dev-account` seeds one — owned by a fixture account created for the purpose.
 *
 * Why this exists: the accounts split (2026-10-03) deleted the amount columns the old
 * fixtures wrote, and every Anthers-side read now resolves the user's holding on the
 * Anthers ladder — which no test session seeds, because that seeding runs in a dev session's
 * `db:seed` (`ensure-dev-account`), not in a test session. A suite that "gives $N to
 * Anthers" awaits {@link ensureAnthersLadder} before writing holdings; every suite shares the
 * one ladder, and `ensureAnthersBadges` is idempotent on (creator, threshold), so repeat
 * calls cost one upsert pass.
 *
 * 🚨 **Found by email on every call, not memoized past the first answer.** A suite's
 * `purgeAccountsCreatedHere` takes back everything above ITS high-water mark, and an owner
 * created inside some suite's setup stands above a later-registered mark — so the row can
 * genuinely be gone between suites (taking the ladder's own rows, which cascade from it).
 * Memoizing the user id would hand the next suite a dead owner and every write would land
 * on a deleted account. The re-check is one indexed SELECT per suite setup.
 *
 * ⭐ **The stand-in carries the reserved "anthers" handle name, brought** (2026-10-04):
 * `anthersUserId` resolves the Anthers creator account by its handle's first label, so the
 * fixture account must hold that name on the session's suffix — the same shape the
 * production account has on `anthers.org`, and the same one the gauntlet's Anthers
 * stand-in and the session preload create.
 */
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { ensureAnthersBadges } from "../services/anthers-badges";
import { createAccount } from "./account-fixture";

const ANTHERS_LADDER_EMAIL = "seed_org_ladder@example.com";

/**
 * Ensure the Anthers ladder exists in this session, and return the owner's user id.
 *
 * Idempotent; safe to await from every suite's `beforeAll`. Sequential-file execution
 * (see `cleanup.ts`) is what makes "the session shares one ladder" honest.
 */
export async function ensureAnthersLadder(): Promise<number> {
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, ANTHERS_LADDER_EMAIL))
		.limit(1);
	if (existing) {
		await ensureAnthersBadges(existing.id);
		return existing.id;
	}
	// Through `createAccount`, not a hand-written row: the stand-in gets a real identity
	// on the session's network, exactly as every account in a test session has one, and no
	// placeholder DID is anywhere in the file. Brought, with the reserved-name exception —
	// the name IS the official one the reservation exists to protect (see the module note).
	const account = await createAccount("anthers", {
		email: ANTHERS_LADDER_EMAIL,
		emailVerified: true,
		identity: "brought",
		bypassReserved: true,
	});
	await ensureAnthersBadges(account.userId);
	return account.userId;
}
