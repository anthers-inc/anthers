// SPDX-License-Identifier: Apache-2.0
/**
 * The longest handle Anthers offers is one the identity server will issue, and one character more
 * is one it will not.
 *
 * 🚨 **Two limits that must agree and live in different programs.** The card and the availability
 * check apply `MAX_HANDLE_NAME`; the server applies its own when the account is created, which is
 * after the person has proved their address. A gap between them fails at the worst moment, and it
 * did: Anthers allowed 30 characters against the server's 18. So this asks the session's real
 * server rather than restating its number.
 */
import { describe, expect, it } from "bun:test";
import { handleSyntaxProblem, MAX_HANDLE_NAME } from "@anthers/shared/handles";
import { hostedHandleSuffix } from "../services/hosted-accounts.js";

const SERVER = process.env.HOSTED_PDS_URL ?? "";

async function createOnServer(name: string): Promise<{ status: number; error?: string }> {
	const res = await fetch(`${SERVER}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			handle: `${name}.${await hostedHandleSuffix()}`,
			email: `${name}@example.com`,
			password: crypto.randomUUID(),
			inviteCode: process.env.HOSTED_PDS_INVITE_CODE,
		}),
	});
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	return { status: res.status, error: body.error };
}

/** A name of exactly `length` characters that nobody else in the session has asked for. */
function nameOfLength(length: number): string {
	const seed = `h${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
	return seed.slice(0, length);
}

describe("the longest handle name", () => {
	it("is one the identity server issues", async () => {
		const name = nameOfLength(MAX_HANDLE_NAME);
		expect(handleSyntaxProblem(name)).toBeNull();
		expect(await createOnServer(name)).toMatchObject({ status: 200 });
	});

	it("is the server's limit, so one character more is refused by both", async () => {
		const name = nameOfLength(MAX_HANDLE_NAME + 1);
		expect(handleSyntaxProblem(name)).toContain("at most");
		expect(await createOnServer(name)).toMatchObject({ status: 400, error: "InvalidHandle" });
	});
});
