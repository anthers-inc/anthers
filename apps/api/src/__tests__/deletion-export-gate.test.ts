// SPDX-License-Identifier: Apache-2.0
/**
 * The deletion gate: a fresh identity bundle, or a deliberate bypass.
 *
 * The gate is the difference between a deletion that is recoverable elsewhere and one that is
 * not, so the tests are about the refusal as much as the acceptance: an account with no bundle
 * must not be schedulable, and the refusal must carry the timestamp the screen needs.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { deletionPreview, isFreshExport, requestDeletion } from "../services/account-deletion.js";
import { createAccount } from "./account-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

async function call(path: string, cookie: string, options: RequestInit = {}): Promise<Response> {
	return app.fetch(
		new Request(`${ORIGIN}${path}`, {
			...options,
			headers: {
				cookie,
				origin: ORIGIN,
				"Content-Type": "application/json",
				...(options.headers ?? {}),
			},
		}),
	);
}

async function leaver(name: string) {
	const account = await createAccount(name);
	return account;
}

describe("the deletion export gate", () => {
	it("refuses a deletion with no bundle, and names the timestamp", async () => {
		const account = await leaver("leaver-no-bundle");
		const result = await requestDeletion(account.userId);
		expect(result).toEqual({ ok: false, reason: "export_required", exportedAt: null });

		const [row] = await db
			.select({ deletionRequestedAt: users.deletionRequestedAt })
			.from(users)
			.where(eq(users.id, account.userId));
		expect(row?.deletionRequestedAt).toBeNull();
	});

	it("accepts a fresh bundle", async () => {
		const account = await leaver("leaver-fresh");
		await db
			.update(users)
			.set({ atprotoExportedAt: new Date() })
			.where(eq(users.id, account.userId));

		const result = await requestDeletion(account.userId);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.scheduledFor).toBeTruthy();
	});

	it("refuses a stale bundle, and accepts an explicit bypass", async () => {
		const account = await leaver("leaver-stale");
		const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		await db.update(users).set({ atprotoExportedAt: stale }).where(eq(users.id, account.userId));

		const refused = await requestDeletion(account.userId);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.exportedAt).toBe(stale.toISOString());

		const bypassed = await requestDeletion(account.userId, { bypassExport: true });
		expect(bypassed.ok).toBe(true);
	});

	it("counts the spaces the deletion would destroy and reports the bundle's age", async () => {
		const account = await leaver("leaver-preview");
		const preview = await deletionPreview(account.userId);
		expect(preview.spaces).toBe(0);
		expect(preview.exportedAt).toBeNull();
		expect(preview.hasRecentExport).toBe(false);

		expect(isFreshExport(new Date())).toBe(true);
		expect(isFreshExport(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))).toBe(false);
		expect(isFreshExport(null)).toBe(false);
	});

	it("answers the wire with a refusal the screen can act on, and a bypass it can send", async () => {
		const account = await leaver("leaver-wire");

		const refused = await call("/api/accounts/me", account.cookie, { method: "DELETE" });
		expect(refused.status).toBe(409);
		const body = (await refused.json()) as { code?: string };
		expect(body.code).toBe("export_required");

		const bypassed = await call("/api/accounts/me", account.cookie, {
			method: "DELETE",
			body: JSON.stringify({ bypassExport: true }),
		});
		expect(bypassed.status).toBe(200);
	});
});
