// SPDX-License-Identifier: Apache-2.0
/**
 * Retiring the hub's sealed copies of hosted account passwords.
 *
 * 🚨 **A stored password is a copy of a secret its owner can change from outside, and the column
 * that holds it is a migration artifact.** Nothing writes one any more: signup takes the password
 * the person chose, the node stores the hash, and Anthers keeps the session that answers. Rows
 * created before that change still carry one, and `services/hosted-session-store.ts` reads it as
 * the fallback that opens a session when there is none on file.
 *
 * ⭐ **So the fix is a session, not a deletion.** A row with a password and no session converts by
 * opening one — with the password it already holds — and then dropping the password, because the
 * session is what every caller actually uses. A row that already has a live session owes nothing
 * but the drop. Nothing here deletes a credential the hub still needs.
 *
 * 🚨 **The drop happens only after the session is on file, and a refusal keeps the password.** That
 * order is the whole safety property: deleting the hub's only remaining way into an identity whose
 * session could not be opened would strand it behind the node's admin password, which is the state
 * the runbook describes for `signup-probe` and does not want repeated on purpose.
 *
 * ⚠️ **A password the node no longer accepts cannot be converted, and reporting it is the honest
 * outcome.** That is the state a reset creates: the owner changed their password at the node, the
 * server's hash no longer matches this copy, and the row keeps it until the holder signs in or
 * resets through Anthers, both of which write a session and empty the column. An operator reading
 * this output should send those people to **Settings → Identity → Your Identity Server**, not
 * hand-edit a row.
 */
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq, ne } from "drizzle-orm";
import { sessionForHostedAccount } from "./hosted-session-store.js";
import { open, secretBoxConfigured } from "./secret-box.js";

/** One row that still holds a password, as an operator needs to see it. */
export interface SealedPasswordRow {
	did: string;
	handle: string;
	userId: number | null;
	hasSession: boolean;
	/**
	 * Whether this deployment's key opens the sealed value.
	 *
	 * `open` throws rather than returning empty on a value sealed elsewhere, so this is a fact
	 * worth reporting: an unopenable row is one nothing here can act on.
	 *
	 * ⚠️ **`null` is not "unopenable" — it is "cannot tell", and the difference matters.** Run
	 * without `HOSTED_ACCOUNT_KEY` (which `make prod-db` does not inject) every row would read as
	 * unopenable, which is the same answer a wrong key gives and would send an operator hunting a
	 * seal that is fine. The key's absence is reported once, by the caller.
	 */
	openable: boolean | null;
}

/** What a convert run did with one row. */
export interface ConvertOutcome extends SealedPasswordRow {
	/** The session is on file and the password is gone. */
	converted: boolean;
	/** Why it was left as it was, when it was. */
	refused?: string;
}

function openable(sealedPassword: string): boolean | null {
	if (!secretBoxConfigured()) return null;
	try {
		open(sealedPassword);
		return true;
	} catch {
		return false;
	}
}

/**
 * Every row that still holds a password.
 *
 * `ne(…, "")` rather than a null test, because the column is `NOT NULL` with an empty string
 * standing in for absence — the sentinel the schema docblock records.
 */
export async function sealedPasswordRows(): Promise<SealedPasswordRow[]> {
	const rows = await db
		.select({
			did: hostedAccounts.did,
			handle: hostedAccounts.handle,
			userId: hostedAccounts.userId,
			sealedPassword: hostedAccounts.sealedPassword,
			sealedSession: hostedAccounts.sealedSession,
		})
		.from(hostedAccounts)
		.where(ne(hostedAccounts.sealedPassword, ""));
	return rows.map((r) => ({
		did: r.did,
		handle: r.handle,
		userId: r.userId,
		hasSession: r.sealedSession !== null,
		openable: openable(r.sealedPassword),
	}));
}

/**
 * Convert every row, dropping each password once its session is on file.
 *
 * `dryRun` reports what it would do without writing, which is what an operator runs against
 * production first. The order inside the loop is the safety property above.
 */
export async function convertSealedPasswords(
	opts: { dryRun?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ConvertOutcome[]> {
	// 🚨 **Refused outright rather than attempted per row.** Without the key nothing can be
	// opened, so every row would fail with "the sealed credential cannot be opened" — an answer
	// that reads as a broken seal on every identity at once rather than as a missing environment
	// variable. Nothing is written, which is the safe direction, but the report should say why.
	if (!opts.dryRun && !secretBoxConfigured()) {
		throw new Error(
			"HOSTED_ACCOUNT_KEY is not set, so no sealed credential can be opened. " +
				"Nothing has been changed.",
		);
	}
	const rows = await sealedPasswordRows();
	const outcomes: ConvertOutcome[] = [];

	for (const row of rows) {
		if (opts.dryRun) {
			outcomes.push({ ...row, converted: false });
			continue;
		}

		// ⭐ The store, not a login written here: it reuses the session already on file, renews
		// an expiring one, and only then spends the password as the fallback it is.
		const opened = await sessionForHostedAccount(row.did, {
			fetchImpl: opts.fetchImpl ?? fetch,
		});
		if (opened.token === null) {
			outcomes.push({ ...row, converted: false, refused: opened.error });
			continue;
		}

		await db
			.update(hostedAccounts)
			.set({ sealedPassword: "" })
			.where(eq(hostedAccounts.did, row.did));
		outcomes.push({ ...row, converted: true });
	}

	return outcomes;
}
