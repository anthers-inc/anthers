// SPDX-License-Identifier: Apache-2.0
/**
 * An identity on the session's Bluesky stand-in, for signing in through the Bluesky door by hand.
 *
 * The stand-in is a real authorization server with its own sign-in page, so walking the door in
 * `make dev` needs an account there and its password. This makes one for the session and prints
 * both; nothing about it survives the session, so the password is drawn fresh each time.
 *
 * ⚠️ **It has no Anthers account.** Taking the Bluesky door with it is the signup, exactly as it
 * would be for somebody arriving from `bsky.social`.
 *
 * Usage: `bun run db:bluesky-identity` (run by `bun run db:seed`).
 */

import { assertDevCheckout } from "@anthers/db/dev-only";

const TAG = "[bluesky-identity]";

async function main() {
	assertDevCheckout();
	const server = process.env.BLUESKY_STAND_IN_URL;
	if (!server) {
		console.log(`${TAG} no Bluesky stand-in in this environment — skipping.`);
		return;
	}
	const handle = `bluesky-${crypto.randomUUID().slice(0, 4)}.bsky.test`;
	const password = crypto.randomUUID();
	const res = await fetch(`${server}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle, email: `${handle}@example.com`, password }),
	});
	if (!res.ok) throw new Error(`the stand-in refused the identity: ${await res.text()}`);
	console.log(
		`${TAG} sign in through the Bluesky door as ${handle} with password ${password} ` +
			`(its email codes arrive in the session's mail catcher).`,
	);
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(`${TAG} failed:`, err);
		process.exit(1);
	},
);
