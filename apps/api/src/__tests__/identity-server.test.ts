// SPDX-License-Identifier: Apache-2.0
/**
 * The server holding an account's identity, on the wire to the browser.
 *
 * ⚠️ **Settings links that server's own account page, so the client has to be told which server
 * it is.** The URL is public — it is the `#atproto_pds` service in the DID document — and the
 * value comes from the row, so this test is about the field reaching BOTH payloads the account
 * reads. `/auth/me` is the shell's boot read and `/api/accounts/me` is the account page's; a
 * field added to one and not the other would show the link on some loads and not others.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `identityserver${Date.now().toString(36)}`;
let cookie = "";

beforeAll(async () => {
	cookie = (await createAccount(RUN)).cookie;
});

function get(path: string) {
	return app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }));
}

describe("the identity's server in the account payloads", () => {
	it("rides both the boot read and the account page's read", async () => {
		const boot = (await (await get("/api/auth/me")).json()) as {
			user: { atprotoPdsUrl: string } | null;
		};
		const account = (await (await get("/api/accounts/me")).json()) as {
			user: { atprotoPdsUrl: string };
		};

		expect(boot.user?.atprotoPdsUrl).toMatch(/^https?:\/\//);
		if (!boot.user) throw new Error("expected the boot read to carry the signed-in account");
		expect(account.user.atprotoPdsUrl).toBe(boot.user.atprotoPdsUrl);
	});
});
