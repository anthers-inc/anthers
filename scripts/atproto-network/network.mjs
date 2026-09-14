// SPDX-License-Identifier: Apache-2.0
/**
 * A private AT Protocol network for development and tests: a PLC directory and a Personal Data
 * Server, both held in memory and gone when the process stops.
 *
 *   make pds-up      # build and start it
 *   make pds-test    # run the record-writing integration tests against it
 *   make pds-down    # stop it, which discards everything it held
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
 * ⚠️ **The ports are fixed, and they are the AT Protocol tooling's own conventions** — 2582 for the
 * directory and 2583 for the server — because the server writes its own address into every
 * identity it creates, and that address has to be the one the host reaches it on.
 */
import { TestNetworkNoAppView } from "@atproto/dev-env";

const PLC_PORT = 2582;
const PDS_PORT = 2583;

const network = await TestNetworkNoAppView.create({
	plc: { port: PLC_PORT },
	pds: { port: PDS_PORT },
});

const directory = network.pds.ctx.cfg.identity.plcUrl;
const crawlers = network.pds.ctx.cfg.crawlers;
if (directory !== network.plc.url || crawlers.length > 0) {
	console.error(
		`refusing to run: the server registers identities with ${directory} and asks ` +
			`${crawlers.length} relay(s) to crawl it; it must use only ${network.plc.url} and none`,
	);
	await network.close();
	process.exit(1);
}

console.log(`AT Protocol network ready: directory ${network.plc.url}, server ${network.pds.url}`);

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	await network.close().catch((err) => console.error(err));
	process.exit(0);
}
// A process running as a container's first process gets no default signal handling, so without
// these `docker stop` would wait out its timeout and then kill the network uncleanly.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
