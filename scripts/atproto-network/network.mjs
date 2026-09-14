// SPDX-License-Identifier: Apache-2.0
/**
 * A private AT Protocol network for development and tests: a PLC directory and a Personal Data
 * Server, both held in memory and gone when the process stops.
 *
 * `scripts/session.ts` starts one for every `make dev` and every test run and removes it when the
 * run ends, so nothing it held outlives the session that made it.
 *
 * 🛑 **Nothing here may reach the real network, and the directory is the part that decides it.**
 * An identity registered with `plc.directory` is permanent — its log is append-only, and without
 * the rotation key it cannot even be tombstoned — while a Personal Data Server not told otherwise
 * registers every account it creates there. So this network brings its own directory, and refuses
 * to start at all unless the server is pointed at it.
 *
 * ⭐ **It is Bluesky's own test network rather than one of ours.** `@atproto/dev-env` is what the
 * AT Protocol's reference implementation tests against, and running it unmodified is the same
 * choice the Anthers node makes about the server itself. It runs under Node inside a container
 * because it cannot run under Bun: its server depends on `better-sqlite3`, which Bun refuses to
 * load, and on `undici` internals that Bun replaces with its own.
 *
 * ⚠️ **The container must publish each port on the same number it listens on**, because the server
 * writes its own address into every identity it creates, and that address has to be the one the
 * host reaches it on. The defaults are the AT Protocol tooling's own conventions — 2582 for the
 * directory and 2583 for the server — plus 2586 for the Bluesky stand-in, and `make dev` keeps
 * them; a test run picks free ports and passes them in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mockNetworkUtilities, TestNetworkNoAppView, TestPds } from "@atproto/dev-env";

const PLC_PORT = Number(process.env.PLC_PORT ?? 2582);
const PDS_PORT = Number(process.env.PDS_PORT ?? 2583);
const BLUESKY_PORT = Number(process.env.BLUESKY_PORT ?? 2586);
/** Where `lexicons-published/` is, so the network can serve the schemas Anthers has published. */
const LEXICONS_DIR = process.env.LEXICONS_DIR;

const network = await TestNetworkNoAppView.create({
	plc: { port: PLC_PORT },
	pds: {
		port: PDS_PORT,
		// ⚠️ **One two-label domain, shaped like production's `anthers.social`**, rather than dev-env's
		// default `.test` and `.example`. The hub issues handles under the first domain the server
		// offers, and erasing an account readdresses it to `deleted-…@` that domain — which the server
		// refuses as an address when the domain is a bare `test`.
		serviceHandleDomains: [".anthers.test"],
	},
});

/**
 * ⭐ **A second server standing in for `bsky.social`**, where identities Anthers does not host live.
 * It is what lets the Bluesky door be walked for real on a local network: an identity created here
 * signs in through this server's own OAuth pages, and the hub reaches it only through the grant,
 * exactly as it reaches one on Bluesky. It shares the network's directory, and issues handles under
 * `.bsky.test` so an identity's home is legible from its name.
 */
const bluesky = await TestPds.create({
	port: BLUESKY_PORT,
	didPlcUrl: network.plc.url,
	serviceHandleDomains: [".bsky.test"],
	serviceName: "Bluesky stand-in",
});
mockNetworkUtilities(bluesky);

const servers = [network.pds, bluesky];
for (const server of servers) {
	const directory = server.ctx.cfg.identity.plcUrl;
	const crawlers = server.ctx.cfg.crawlers;
	if (directory !== network.plc.url || crawlers.length > 0) {
		console.error(
			`refusing to run: ${server.url} registers identities with ${directory} and asks ` +
				`${crawlers.length} relay(s) to crawl it; it must use only ${network.plc.url} and none`,
		);
		await bluesky.close().catch(() => {});
		await network.close();
		process.exit(1);
	}
}

/**
 * Serve the schemas Anthers has published, from an Anthers account on the Bluesky stand-in — where
 * `anthers.org` really lives on `bsky.social`.
 *
 * 🚨 **Without this the Bluesky door cannot be signed through at all.** Anthers asks for its
 * published permission sets (`include:org.anthers.userPermissions`), and an authorization server
 * resolves a permission set's Lexicon through the `_lexicon.anthers.org` DNS record — the real
 * network, which a private one must not reach and cannot. So the published copies are written into
 * a local account exactly as the publisher writes them, and the stand-in's resolver is pointed at
 * that account through the override the reference server provides for this (`PDS_LEXICON_AUTHORITY_DID`),
 * set once the account's DID exists. Only the DNS step is replaced; the fetch is the real one.
 */
async function publishAnthersLexicons(server, dir) {
	const password = crypto.randomUUID();
	const created = await fetch(`${server.url}/xrpc/com.atproto.server.createAccount`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle: "anthers.bsky.test", email: "anthers@example.com", password }),
	});
	const account = await created.json();
	if (!created.ok)
		throw new Error(`could not create the Lexicon account: ${JSON.stringify(account)}`);

	const files = readdirSync(dir, { recursive: true }).filter((file) =>
		String(file).endsWith(".json"),
	);
	for (const file of files) {
		const lexicon = JSON.parse(readFileSync(join(dir, String(file)), "utf8"));
		const put = await fetch(`${server.url}/xrpc/com.atproto.repo.putRecord`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.accessJwt}` },
			body: JSON.stringify({
				repo: account.did,
				collection: "com.atproto.lexicon.schema",
				rkey: lexicon.id,
				record: { $type: "com.atproto.lexicon.schema", ...lexicon },
			}),
		});
		if (!put.ok) throw new Error(`could not publish ${lexicon.id}: ${await put.text()}`);
	}
	server.ctx.cfg.lexicon.didAuthority = account.did;
	return files.length;
}

const published = LEXICONS_DIR ? await publishAnthersLexicons(bluesky, LEXICONS_DIR) : 0;

console.log(
	`AT Protocol network ready: directory ${network.plc.url}, server ${network.pds.url}, ` +
		`Bluesky stand-in ${bluesky.url} serving ${published} published schema(s)`,
);

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	await bluesky.close().catch((err) => console.error(err));
	await network.close().catch((err) => console.error(err));
	process.exit(0);
}
// A process running as a container's first process gets no default signal handling, so without
// these `docker stop` would wait out its timeout and then kill the network uncleanly.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
