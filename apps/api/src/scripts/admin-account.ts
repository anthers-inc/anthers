// SPDX-License-Identifier: Apache-2.0
/**
 * Manage admin accounts from a terminal, against whatever `DATABASE_URL` names.
 *
 * This is how the first admin account exists, and it is the recovery path when no super-admin can
 * sign in — most often because the address an account signs in with has stopped receiving mail.
 * Every other change to an admin account is made by a super-admin in the admin app's Accounts
 * section. Both doors go through `services/admin-accounts.ts`, so the script cannot remove the
 * last super-admin either, and every change it makes is recorded with no actor, which is how the
 * record says *somebody with database access did this*.
 *
 *   bun run admin:account list
 *   bun run admin:account create <email> --name "Display Name" [--super]
 *   bun run admin:account email <current-email> <new-email>
 *   bun run admin:account super <email> [--revoke]
 *   bun run admin:account deactivate <email>
 *   bun run admin:account reactivate <email>
 *
 * In production, point `DATABASE_URL` at the managed database for the one command:
 *   DATABASE_URL="$(doctl databases connection <id> --format URI --no-header)" \
 *     bun run admin:account list
 *
 * ⚠️ **Deliberately not guarded by `assertDevCheckout`.** Running against a deployed database is
 * this script's purpose rather than its failure mode, the same line `packages/db/src/dev-only.ts`
 * draws for the script this one replaces.
 */
import {
	type AdminAccount,
	AdminAccountError,
	changeAdminEmail,
	createAdminAccount,
	deactivateAdminAccount,
	findAdminAccountByEmail,
	listAdminAccounts,
	reactivateAdminAccount,
	setSuperAdmin,
} from "../services/admin-accounts.js";

const TAG = "[admin-account]";

const USAGE = `usage:
  bun run admin:account list
  bun run admin:account create <email> --name "Display Name" [--super]
  bun run admin:account email <current-email> <new-email>
  bun run admin:account super <email> [--revoke]
  bun run admin:account deactivate <email>
  bun run admin:account reactivate <email>`;

/** What each refusal means to the person at the terminal. */
const REFUSALS: Record<AdminAccountError["reason"], string> = {
	not_found: "no admin account has that address.",
	email_taken: "another admin account already signs in with that address.",
	last_super_admin:
		"that is the last active super-admin, so it cannot be demoted or deactivated. Make another account a super-admin first.",
	already_in_that_state: "the account is already in that state, so nothing changed.",
};

function describe(account: AdminAccount): string {
	const roles = [account.isSuperAdmin ? "super-admin" : "admin"];
	if (account.deactivatedAt) roles.push(`deactivated ${account.deactivatedAt.toISOString()}`);
	return `#${account.id} ${account.email} "${account.displayName}" (${roles.join(", ")})`;
}

async function requireAccount(email: string | undefined): Promise<AdminAccount> {
	if (!email) throw new UsageError();
	const account = await findAdminAccountByEmail(email);
	if (!account) throw new AdminAccountError("not_found");
	return account;
}

class UsageError extends Error {}

function flagValue(args: string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	const positional = rest.filter((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--name");

	switch (command) {
		case "list": {
			const accounts = await listAdminAccounts();
			if (accounts.length === 0) console.log(`${TAG} there are no admin accounts yet.`);
			for (const account of accounts) console.log(describe(account));
			return;
		}
		case "create": {
			const name = flagValue(rest, "--name");
			if (!positional[0] || !name) throw new UsageError();
			const account = await createAdminAccount(
				{ email: positional[0], displayName: name, isSuperAdmin: rest.includes("--super") },
				null,
			);
			console.log(`${TAG} created ${describe(account)}`);
			return;
		}
		case "email": {
			const account = await requireAccount(positional[0]);
			if (!positional[1]) throw new UsageError();
			const updated = await changeAdminEmail(account.id, positional[1], null);
			console.log(`${TAG} ${describe(updated)} now signs in with its new address.`);
			return;
		}
		case "super": {
			const account = await requireAccount(positional[0]);
			const updated = await setSuperAdmin(account.id, !rest.includes("--revoke"), null);
			console.log(`${TAG} ${describe(updated)}`);
			return;
		}
		case "deactivate": {
			const account = await requireAccount(positional[0]);
			console.log(`${TAG} ${describe(await deactivateAdminAccount(account.id, null))}`);
			return;
		}
		case "reactivate": {
			const account = await requireAccount(positional[0]);
			console.log(`${TAG} ${describe(await reactivateAdminAccount(account.id, null))}`);
			return;
		}
		default:
			throw new UsageError();
	}
}

try {
	await main(process.argv.slice(2));
	process.exit(0);
} catch (err) {
	if (err instanceof UsageError) {
		console.error(USAGE);
		process.exit(2);
	}
	if (err instanceof AdminAccountError) {
		console.error(`${TAG} refused: ${REFUSALS[err.reason]}`);
		process.exit(1);
	}
	console.error(`${TAG} FAILED:`, err);
	process.exit(1);
}
