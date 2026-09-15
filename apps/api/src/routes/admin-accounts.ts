// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's Accounts section: inviting, deactivating and reactivating admin accounts,
 * changing the address one signs in with, and granting or removing super-admin.
 *
 * 🚨 **The whole section is super-admin only.** If an ordinary admin account could invite, getting
 * into one would be a way to add more, so the check is on the router rather than on individual
 * actions. It is a 403 rather than the 404 the rest of the world gets: the request has already
 * reached the admin host with a valid admin session, where the section's existence is no secret.
 *
 * Every change goes through `services/admin-accounts.ts`, which records who made it and refuses to
 * remove the last active super-admin, so this router cannot leave a state the recovery script
 * could not.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AdminEnv } from "../middleware/admin.js";
import {
	AdminAccountError,
	type AdminAccountRefusal,
	changeAdminEmail,
	createAdminAccount,
	deactivateAdminAccount,
	listAdminAccountEvents,
	listAdminAccounts,
	reactivateAdminAccount,
	serializeAdminAccountListing,
	setSuperAdmin,
} from "../services/admin-accounts.js";
import { sendAdminInvitationEmail } from "../services/email.js";

const requireSuperAdmin = createMiddleware<AdminEnv>(async (c, next) => {
	if (!c.get("admin").isSuperAdmin) {
		return c.json(
			{ error: "Managing admin accounts needs a super-admin.", code: "super_admin_required" },
			403,
		);
	}
	await next();
});

/** What each refusal means to the super-admin who asked. */
const REFUSALS: Record<AdminAccountRefusal, { status: 404 | 409; error: string }> = {
	not_found: { status: 404, error: "No admin account with that id." },
	email_taken: { status: 409, error: "Another admin account already signs in with that address." },
	last_super_admin: {
		status: 409,
		error: "That is the last active super-admin. Make another account a super-admin first.",
	},
	already_in_that_state: { status: 409, error: "The account is already in that state." },
};

const inviteSchema = z.object({
	email: z.string().email().max(254),
	displayName: z.string().trim().min(1).max(120),
	isSuperAdmin: z.boolean().optional(),
});

const emailSchema = z.object({ email: z.string().email().max(254) });
const superAdminSchema = z.object({ isSuperAdmin: z.boolean() });

/** Run an account change, turning a refusal into its response. */
async function change<T>(
	run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: AdminAccountRefusal }> {
	try {
		return { ok: true, value: await run() };
	} catch (err) {
		if (err instanceof AdminAccountError) return { ok: false, reason: err.reason };
		throw err;
	}
}

/** The admin app's own origin, for the link in an invitation. */
function adminAppUrl(): string {
	return (process.env.ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

export const adminAccountRoutes = new Hono<AdminEnv>()
	.use("*", requireSuperAdmin)

	.get("/", async (c) => {
		const [accounts, events] = await Promise.all([listAdminAccounts(), listAdminAccountEvents()]);
		return c.json({ accounts: accounts.map(serializeAdminAccountListing), events });
	})

	// Inviting creates the account and tells its owner where to sign in. There is nothing to accept:
	// the account exists from this moment, and signing in with a code sent to the address is the
	// whole of joining.
	.post("/", zValidator("json", inviteSchema), async (c) => {
		const admin = c.get("admin");
		const input = c.req.valid("json");
		const result = await change(() => createAdminAccount(input, admin.id));
		if (!result.ok) {
			const refusal = REFUSALS[result.reason];
			return c.json({ error: refusal.error, code: result.reason }, refusal.status);
		}
		void sendAdminInvitationEmail(result.value.email, admin.displayName, adminAppUrl()).catch(
			(err) => console.error("[admin accounts] failed to send an invitation:", err),
		);
		return c.json({ account: serializeAdminAccountListing(result.value) }, 201);
	})

	.post("/:id/deactivate", async (c) => {
		const result = await change(() =>
			deactivateAdminAccount(Number(c.req.param("id")), c.get("admin").id),
		);
		if (!result.ok) {
			const refusal = REFUSALS[result.reason];
			return c.json({ error: refusal.error, code: result.reason }, refusal.status);
		}
		return c.json({ account: serializeAdminAccountListing(result.value) });
	})

	.post("/:id/reactivate", async (c) => {
		const result = await change(() =>
			reactivateAdminAccount(Number(c.req.param("id")), c.get("admin").id),
		);
		if (!result.ok) {
			const refusal = REFUSALS[result.reason];
			return c.json({ error: refusal.error, code: result.reason }, refusal.status);
		}
		return c.json({ account: serializeAdminAccountListing(result.value) });
	})

	.post("/:id/email", zValidator("json", emailSchema), async (c) => {
		const { email } = c.req.valid("json");
		const result = await change(() =>
			changeAdminEmail(Number(c.req.param("id")), email, c.get("admin").id),
		);
		if (!result.ok) {
			const refusal = REFUSALS[result.reason];
			return c.json({ error: refusal.error, code: result.reason }, refusal.status);
		}
		return c.json({ account: serializeAdminAccountListing(result.value) });
	})

	.post("/:id/super-admin", zValidator("json", superAdminSchema), async (c) => {
		const { isSuperAdmin } = c.req.valid("json");
		const result = await change(() =>
			setSuperAdmin(Number(c.req.param("id")), isSuperAdmin, c.get("admin").id),
		);
		if (!result.ok) {
			const refusal = REFUSALS[result.reason];
			return c.json({ error: refusal.error, code: result.reason }, refusal.status);
		}
		return c.json({ account: serializeAdminAccountListing(result.value) });
	});
