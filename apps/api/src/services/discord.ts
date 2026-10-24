// SPDX-License-Identifier: Apache-2.0
/**
 * The Anthers Discord server's membership and roles.
 *
 * 🚨 **This is the only module that holds the bot token and the only writer of a role.** The
 * token can rewrite the server, so it lives in Bitwarden Secrets and reaches the process as an
 * environment variable; nothing else in the codebase reads it, and no route talks to Discord
 * directly. A new caller goes through a function here.
 *
 * ⭐ **Roles follow Anthers' own record, not which invitation somebody used.** Only two roles
 * are ever written — `User` on join and `Creator` for an account `@anthers/shared/verified-creator`
 * calls verified — and every other role in the server (`Admin`, `Dev`) is invisible to this
 * module. That is why the diff below removes only the Creator role rather than reconciling the
 * member's whole set: a bot that "tidied" roles would take away the ones people are given by hand.
 *
 * ⚠️ **Reconciled, not set once.** The grant at link time is the easy half; the state that rots
 * is the member who stopped being a creator months ago, or the grant that Discord refused on a
 * bad night. `reconcileRoles` is what the daily job runs, and it fixes both directions.
 *
 * The API spells the server `guild` — `guilds.join`, `/guilds/{id}` — while every identifier we
 * name says server, because that is what Discord calls it to a person.
 */
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { verifiedCreator } from "@anthers/shared/verified-creator";
import { eq, isNotNull } from "drizzle-orm";
import { releasedWorkCount } from "./creator-standing.js";

const API = "https://discord.com/api/v10";
const AUTHORIZE = "https://discord.com/oauth2/authorize";

export type DiscordConfig = {
	clientId: string;
	clientSecret: string;
	botToken: string;
	serverId: string;
	userRoleId: string;
	creatorRoleId: string;
	redirectUri: string;
};

/**
 * The configuration, or null while the application does not exist yet.
 *
 * Read per call rather than once at import so a test can set the variables in `beforeAll`, and
 * so a missing application leaves the settings card hidden instead of crashing the API.
 */
export function discordConfig(): DiscordConfig | null {
	const {
		DISCORD_CLIENT_ID: clientId,
		DISCORD_CLIENT_SECRET: clientSecret,
		DISCORD_BOT_TOKEN: botToken,
		DISCORD_SERVER_ID: serverId,
		DISCORD_USER_ROLE_ID: userRoleId,
		DISCORD_CREATOR_ROLE_ID: creatorRoleId,
		DISCORD_REDIRECT_URI: redirectUri,
	} = process.env;
	if (!clientId || !clientSecret || !botToken || !serverId || !userRoleId || !creatorRoleId) {
		return null;
	}
	if (!redirectUri) return null;
	return { clientId, clientSecret, botToken, serverId, userRoleId, creatorRoleId, redirectUri };
}

export function discordConfigured(): boolean {
	return discordConfig() !== null;
}

/**
 * Where to send the browser to authorize the link.
 *
 * `prompt=consent` is deliberate: without it Discord can skip the screen on a second
 * authorization, and the `guilds.join` scope — the whole point of this flow — would not be
 * granted. The state is the caller's nonce, checked against a cookie at the callback.
 */
export function discordAuthorizationUrl(state: string): string {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: "code",
		scope: "identify guilds.join",
		state,
		prompt: "consent",
	});
	return `${AUTHORIZE}?${params.toString()}`;
}

type DiscordUser = { id: string; username: string };

/**
 * Exchange the callback's code for an access token, then read who it belongs to.
 *
 * The access token is the person's, not the bot's, and it is used once — to put them in the
 * server — so it is never stored. Discord token responses are `application/x-www-form-urlencoded`
 * requests, which is why this is not a JSON POST like the rest of the module.
 */
export async function exchangeAuthorizationCode(
	code: string,
): Promise<{ accessToken: string; discordUser: DiscordUser }> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");

	const tokenRes = await fetch(`${API}/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			grant_type: "authorization_code",
			code,
			redirect_uri: config.redirectUri,
		}),
	});
	if (!tokenRes.ok) throw new Error(`Discord refused the code (${tokenRes.status}).`);
	const token = (await tokenRes.json()) as { access_token?: string };
	if (!token.access_token) throw new Error("Discord returned no access token.");

	const userRes = await fetch(`${API}/users/@me`, {
		headers: { Authorization: `Bearer ${token.access_token}` },
	});
	if (!userRes.ok) throw new Error(`Discord refused the identity read (${userRes.status}).`);
	const discordUser = (await userRes.json()) as DiscordUser;
	return { accessToken: token.access_token, discordUser };
}

/** One bot-authenticated request, retrying once on Discord's rate limiter. */
async function botRequest(path: string, init: RequestInit = {}): Promise<Response> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const send = () =>
		fetch(`${API}${path}`, {
			...init,
			headers: {
				Authorization: `Bot ${config.botToken}`,
				"Content-Type": "application/json",
				...init.headers,
			},
		});
	const res = await send();
	if (res.status !== 429) return res;
	const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
	await new Promise((resolve) =>
		setTimeout(resolve, Math.min((body?.retry_after ?? 1) * 1000, 5_000)),
	);
	return send();
}

/**
 * Put the person in the server, or no-op if they are already there.
 *
 * `PUT /guilds/{server}/members/{user}` answers 204 for an existing member and does **not**
 * update their roles, which is why joining and role-granting are separate steps here. Returns
 * whether the member exists after the call, which a 204 also means.
 */
export async function addMemberToServer(
	discordUserId: string,
	accessToken: string,
): Promise<boolean> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const res = await botRequest(`/guilds/${config.serverId}/members/${discordUserId}`, {
		method: "PUT",
		body: JSON.stringify({ access_token: accessToken }),
	});
	// 201 created, 204 already present, 403 a bot whose role sits too low — the last must not
	// read as success, so anything outside the two known answers is a failure.
	if (res.status === 201 || res.status === 204) return true;
	throw new Error(`Discord refused to add the member (${res.status}).`);
}

type GuildMember = { roles: string[] };

async function member(discordUserId: string): Promise<GuildMember | null> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const res = await botRequest(`/guilds/${config.serverId}/members/${discordUserId}`);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Discord refused the member read (${res.status}).`);
	return (await res.json()) as GuildMember;
}

async function addRole(discordUserId: string, roleId: string): Promise<void> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const res = await botRequest(
		`/guilds/${config.serverId}/members/${discordUserId}/roles/${roleId}`,
		{
			method: "PUT",
		},
	);
	if (!res.ok && res.status !== 204) {
		throw new Error(`Discord refused a role grant (${res.status}).`);
	}
}

async function removeRole(discordUserId: string, roleId: string): Promise<void> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const res = await botRequest(
		`/guilds/${config.serverId}/members/${discordUserId}/roles/${roleId}`,
		{
			method: "DELETE",
		},
	);
	if (!res.ok && res.status !== 204) {
		throw new Error(`Discord refused a role removal (${res.status}).`);
	}
}

/**
 * The roles this account should hold: `User` always, `Creator` only while it is verified.
 *
 * The predicate is the shared one, so the server's answer and the site's cannot disagree.
 */
async function desiredRoles(user: { id: number; isCreator: boolean | null }): Promise<Set<string>> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const released = user.isCreator ? await releasedWorkCount(user.id) : 0;
	const verified = verifiedCreator({ isCreator: user.isCreator, releasedWorkCount: released });
	return new Set(verified ? [config.userRoleId, config.creatorRoleId] : [config.userRoleId]);
}

/**
 * Bring one linked account's roles in line with its standing.
 *
 * Answers false when the account is linked but not in the server — somebody who left, which is
 * their choice and not something this module reverses. Only the Creator role is ever removed;
 * every other role in the server belongs to whoever grants it by hand.
 */
export async function syncAccountRoles(userId: number): Promise<boolean> {
	const config = discordConfig();
	if (!config) throw new Error("Discord is not configured.");
	const [user] = await db
		.select({ id: users.id, isCreator: users.isCreator, discordId: users.discordId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user?.discordId) return false;

	const current = await member(user.discordId);
	if (!current) return false;

	const desired = await desiredRoles(user);
	const held = new Set(current.roles);
	for (const roleId of desired) {
		if (!held.has(roleId)) await addRole(user.discordId, roleId);
	}
	if (held.has(config.creatorRoleId) && !desired.has(config.creatorRoleId)) {
		await removeRole(user.discordId, config.creatorRoleId);
	}
	return true;
}

/**
 * Forget the link, and take back only the Creator role.
 *
 * Never a kick: unlinking is not leaving, and the member's `User` role is what lets them stay in
 * the members' channels. A Discord outage here must not block the unlink, so the row is cleared
 * whether or not the role removal succeeds — the daily reconcile never sees the account again,
 * which is the intended end state either way.
 */
export async function unlinkAccount(userId: number): Promise<void> {
	const config = discordConfig();
	const [user] = await db
		.select({ discordId: users.discordId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user?.discordId) return;

	if (config) {
		try {
			await removeRole(user.discordId, config.creatorRoleId);
		} catch (error) {
			console.error("[discord] creator role removal failed during unlink", error);
		}
	}
	await db.update(users).set({ discordId: null }).where(eq(users.id, userId));
}

/**
 * The daily pass: every linked account, its roles checked in both directions.
 *
 * One account failing must not stop the rest, so each is caught and counted; the job's summary
 * is what tells an operator whether the night was clean.
 */
export async function reconcileRoles(): Promise<{ checked: number; failed: number }> {
	if (!discordConfigured()) return { checked: 0, failed: 0 };
	const linked = await db.select({ id: users.id }).from(users).where(isNotNull(users.discordId));
	let failed = 0;
	for (const { id } of linked) {
		try {
			await syncAccountRoles(id);
		} catch (error) {
			failed += 1;
			console.error(`[discord] role sync failed for account ${id}`, error);
		}
	}
	return { checked: linked.length, failed };
}
