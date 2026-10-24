// SPDX-License-Identifier: Apache-2.0
/**
 * Linking an account to Discord, and the roles that follow.
 *
 * The vendor is stubbed at `globalThis.fetch` — the house pattern — as a small stateful server:
 * it knows which members exist and what roles each holds, and role writes change that state, so
 * a later read sees what the code would see against Discord. What is asserted is the calls
 * Anthers makes, not that Discord works. The three that matter:
 *
 *   • joining uses the **person's** access token against the bot's token, and a member already
 *     in the server is still role-synced (204 does not update roles),
 *   • only `User` and `Creator` are ever written, never the hand-managed roles,
 *   • unlinking takes back the Creator role and leaves the membership alone.
 *
 * The daily reconcile is exercised through the service, because its job is the two directions a
 * one-time grant cannot fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { reconcileRoles } from "../services/discord";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `discord${Date.now().toString(36)}`;
const DISCORD_USER = "911111111111111111";
const SERVER = "1550264389146378312";
const USER_ROLE = "1550960808798978248";
const CREATOR_ROLE = "1550960681950650508";
/** Hand-managed, so the bot must never write it — the point of the boundary test below. */
const ADMIN_ROLE = "1550959948190711979";

type Call = { method: string; url: string; body: string | null };
const calls: Call[] = [];
const originalFetch = globalThis.fetch;

/** What the fake server knows: which members exist and which roles each holds. */
const members = new Map<string, string[]>();
let identityId = DISCORD_USER;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const discordFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	const method = (init?.method ?? "GET").toUpperCase();
	calls.push({ method, url, body: (init?.body as string | undefined) ?? null });

	if (url.endsWith("/oauth2/token")) return json({ access_token: "person-access-token" });
	if (url.endsWith("/users/@me")) return json({ id: identityId, username: "tester" });

	const role = url.match(/\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/);
	if (role) {
		const [, memberId, roleId] = role;
		const held = members.get(memberId) ?? [];
		if (method === "PUT" && !held.includes(roleId)) members.set(memberId, [...held, roleId]);
		if (method === "DELETE")
			members.set(
				memberId,
				held.filter((id) => id !== roleId),
			);
		return new Response(null, { status: 204 });
	}

	const joined = url.match(/\/guilds\/\d+\/members\/(\d+)$/);
	if (joined) {
		const memberId = joined[1];
		if (method === "PUT") {
			if (!members.has(memberId)) members.set(memberId, []);
			return new Response(null, { status: 204 });
		}
		const held = members.get(memberId);
		return held ? json({ roles: held }) : json({ message: "Unknown Member" }, 404);
	}

	return json({ message: `unexpected ${method} ${url}` }, 500);
}) as typeof fetch;

beforeAll(() => {
	process.env.DISCORD_CLIENT_ID = "test-client-id";
	process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
	process.env.DISCORD_BOT_TOKEN = "test-bot-token";
	process.env.DISCORD_SERVER_ID = SERVER;
	process.env.DISCORD_USER_ROLE_ID = USER_ROLE;
	process.env.DISCORD_CREATOR_ROLE_ID = CREATOR_ROLE;
	process.env.DISCORD_REDIRECT_URI = "http://localhost:8000/api/discord/callback";
	globalThis.fetch = discordFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	for (const key of [
		"DISCORD_CLIENT_ID",
		"DISCORD_CLIENT_SECRET",
		"DISCORD_BOT_TOKEN",
		"DISCORD_SERVER_ID",
		"DISCORD_USER_ROLE_ID",
		"DISCORD_CREATOR_ROLE_ID",
		"DISCORD_REDIRECT_URI",
	]) {
		delete process.env[key];
	}
});

function req(path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

async function startLink(account: FixtureAccount) {
	const res = await req("/api/discord/connect", { headers: { Cookie: account.cookie } });
	const cookie = res.headers.getSetCookie().find((c) => c.startsWith("discord_oauth_state="));
	return {
		status: res.status,
		location: res.headers.get("location") ?? "",
		state: cookie?.split(";")[0]?.split("=")[1] ?? "",
	};
}

function finishLink(
	account: FixtureAccount,
	state: string,
	query = `code=test-code&state=${state}`,
) {
	return req(`/api/discord/callback?${query}`, {
		headers: { Cookie: `${account.cookie}; discord_oauth_state=${state}` },
	});
}

/** Run the whole link ceremony as one Discord identity, as a browser would. */
async function link(account: FixtureAccount, discordId: string) {
	identityId = discordId;
	const { state } = await startLink(account);
	return finishLink(account, state);
}

async function linkedId(account: FixtureAccount): Promise<string | null> {
	const [row] = await db
		.select({ discordId: users.discordId })
		.from(users)
		.where(eq(users.id, account.userId))
		.limit(1);
	return row?.discordId ?? null;
}

function roleWrites(memberId?: string) {
	return calls.filter(
		(c) => c.url.includes("/roles/") && (!memberId || c.url.includes(`/members/${memberId}/`)),
	);
}

function written(writes: Call[]) {
	return writes.map((c) => `${c.method} ${c.url.split("/").pop()}`).sort();
}

let plain: FixtureAccount;
let other: FixtureAccount;

beforeAll(async () => {
	plain = await createAccount(`${RUN}plain`);
	other = await createAccount(`${RUN}other`);
});

describe("the link", () => {
	it("sends the browser to Discord with a state cookie", async () => {
		const started = await startLink(plain);
		expect(started.status).toBe(302);
		expect(started.location).toContain("discord.com/oauth2/authorize");
		expect(started.location).toContain("scope=identify+guilds.join");
		expect(started.state.length).toBeGreaterThan(10);
	});

	it("links a plain account, joins the server and grants only the User role", async () => {
		members.clear();
		calls.length = 0;
		const res = await link(plain, DISCORD_USER);

		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("discord=linked");
		expect(await linkedId(plain)).toBe(DISCORD_USER);

		const join = calls.find(
			(c) => c.method === "PUT" && c.url.endsWith(`/members/${DISCORD_USER}`),
		);
		expect(join?.body).toContain("person-access-token");
		expect(written(roleWrites(DISCORD_USER))).toEqual([`PUT ${USER_ROLE}`]);
	});

	it("grants the Creator role too when the account is a verified creator", async () => {
		members.clear();
		calls.length = 0;
		const creatorAccount = await createAccount(`${RUN}creator`, { fields: { isCreator: true } });
		await insertWork({ creatorId: creatorAccount.userId, type: "text" });

		const res = await link(creatorAccount, "922222222222222222");
		expect(res.headers.get("location")).toContain("discord=linked");
		expect(written(roleWrites("922222222222222222"))).toEqual(
			[`PUT ${USER_ROLE}`, `PUT ${CREATOR_ROLE}`].sort(),
		);
	});

	it("refuses a state that does not match the cookie, before touching Discord", async () => {
		calls.length = 0;
		const res = await req("/api/discord/callback?code=test-code&state=forged", {
			headers: { Cookie: `${other.cookie}; discord_oauth_state=the-real-state` },
		});
		expect(res.headers.get("location")).toContain("discord=state");
		expect(calls).toHaveLength(0);
		expect(await linkedId(other)).toBeNull();
	});

	it("refuses a Discord account another Anthers account already holds", async () => {
		const res = await link(other, DISCORD_USER);
		expect(res.headers.get("location")).toContain("discord=taken");
		expect(await linkedId(other)).toBeNull();
	});
});

describe("unlinking", () => {
	it("forgets the link and takes back only the Creator role, never the membership", async () => {
		const account = await createAccount(`${RUN}unlink`, { fields: { isCreator: true } });
		await db
			.update(users)
			.set({ discordId: "933333333333333333" })
			.where(eq(users.id, account.userId));
		members.set("933333333333333333", [USER_ROLE, CREATOR_ROLE]);

		calls.length = 0;
		const res = await req("/api/discord/unlink", {
			method: "POST",
			headers: { Cookie: account.cookie, Origin: "http://localhost:3000" },
		});
		expect(res.status).toBe(200);
		expect(await linkedId(account)).toBeNull();

		expect(written(roleWrites("933333333333333333"))).toEqual([`DELETE ${CREATOR_ROLE}`]);
		expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/933333333333333333"))).toBe(
			false,
		);
		// The member is still in the server, holding the role that lets them stay.
		expect(members.get("933333333333333333")).toEqual([USER_ROLE]);
	});
});

describe("the daily reconcile", () => {
	it("adds a missing role and removes a Creator role the account no longer earns", async () => {
		const stale = await createAccount(`${RUN}stale`, { fields: { isCreator: true } });
		const demoted = await createAccount(`${RUN}demoted`);
		await db
			.update(users)
			.set({ discordId: "944444444444444444" })
			.where(eq(users.id, stale.userId));
		await db
			.update(users)
			.set({ discordId: "955555555555555555" })
			.where(eq(users.id, demoted.userId));

		// The creator released nothing and so holds no Creator role; the non-creator somehow
		// holds one and should lose it. Both are the drift the daily pass exists for. The
		// creator also carries a hand-managed role, which must survive untouched.
		members.set("944444444444444444", [ADMIN_ROLE]);
		members.set("955555555555555555", [USER_ROLE, CREATOR_ROLE]);
		calls.length = 0;

		const summary = await reconcileRoles();

		expect(summary.failed).toBe(0);
		expect(summary.checked).toBeGreaterThanOrEqual(2);
		expect(written(roleWrites("944444444444444444"))).toEqual([`PUT ${USER_ROLE}`]);
		expect(written(roleWrites("955555555555555555"))).toEqual([`DELETE ${CREATOR_ROLE}`]);
		expect(members.get("944444444444444444")).toContain(ADMIN_ROLE);
	});
});
