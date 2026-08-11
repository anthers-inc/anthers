// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `anthersp2p` — the open client for Anthers' authenticated P2P delivery.
 *
 * Named for both halves it will eventually carry (download *and* hosting), which is why it
 * is not `anthersdl`. Today only the download half exists; see § Seeding below.
 *
 * Usage:
 *   anthersp2p login
 *   anthersp2p pull <workId> <assetId> [--out FILE] [--resume] [--concurrency N]
 *   anthersp2p seed <workId> <assetId> --file F [--announce ORIGIN]
 *   anthersp2p manifest <workId> <assetId>
 *
 * Auth is an opaque `sessions` row carried as a bearer token — the same credential the
 * desktop Studio uses, and no new auth primitive, which is the reasoning 42.06 used.
 * `login` obtains one through the browser handoff (see `auth.ts`) and remembers it, so
 * nothing has to paste a token; `--token` and `ANTHERS_TOKEN` still win where a script
 * needs to name the account it means.
 *
 * ── Seeding is HTTP, not WebRTC, and that was the whole unlock ──────────────────────
 *
 * WebRTC exists to get through NAT. A host that can accept an inbound connection does not
 * need it, and serving over HTTPS costs no new protocol, no native module (Bun ships no
 * `RTCPeerConnection`), and no TURN relay — TURN being bytes *Anthers* would pay for, which
 * would quietly falsify 45.01 § 6's "swarm-served bytes are free to both sides".
 *
 * `seed` answers exactly the hub's own URL shape, so a client pointed at a peer is the hub
 * client with a different origin. One download architecture, not one plus a peer dialect.
 *
 * ⚠️ Still true: a peer that *cannot* accept inbound — an ordinary user behind NAT — needs
 * WebRTC, and the browser client's `{t:"want"}` data-channel path still has nothing
 * answering it. That population is 45.01's "as soon as viable", not a launch requirement.
 */

import { basename } from "node:path";
import { clearStoredToken, LoginError, login, readStoredToken, storeToken } from "./auth.js";
import { discoverPeers } from "./peers.js";
import { AccessDeniedError, fetchManifest, pullAsset, VerificationError } from "./pull.js";
import { SeedError, startSeeder } from "./seed.js";

const DEFAULT_BASE_URL = "https://anthers.org";

function usage(): never {
	console.error(`anthersp2p — the open client for Anthers P2P delivery

  anthersp2p login                                 sign in through your browser
  anthersp2p logout                                forget the stored session
  anthersp2p pull <workId> <assetId> [options]     download and verify an asset
  anthersp2p seed <workId> <assetId> --file F      serve chunks to entitled peers
  anthersp2p manifest <workId> <assetId>           print the manifest as JSON

Options:
  --out FILE          where to write (default: the asset's own filename)
  --file FILE         (seed) the local copy to serve
  --port N            (seed) listen port (default 8080)
  --skip-verify       (seed) don't check the local file first — see the docs, it's a foot-gun
  --resume            re-verify what is on disk and fetch only what is missing
  --concurrency N     chunks in flight (default 4)
  --peer ORIGIN       (pull) prefer this peer; may be repeated, hub is still the fallback
  --no-discover       (pull) don't ask the hub which peers are serving; hub only
  --announce ORIGIN   (seed) the public origin to advertise, e.g. https://seed.example.org
  --url ORIGIN        hub origin (default ${DEFAULT_BASE_URL}, or ANTHERS_URL)
  --web ORIGIN        where the site lives, if not the hub (or ANTHERS_WEB_URL)
  --no-browser        (login) print the URL instead of trying to open it
  --label TEXT        (login) how this device is named on the confirmation page
  --token TOKEN       session token, overriding the stored one (or ANTHERS_TOKEN)

Run 'login' once and the session is remembered; --token and ANTHERS_TOKEN still
win where you need them. Every chunk is verified against the manifest before it
is written, and the finished file is checked end to end. Manifest format: 45.04.`);
	process.exit(2);
}

type Flag = string | boolean | string[];

function parseArgs(argv: string[]) {
	const positional: string[] = [];
	const flags: Record<string, Flag> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			const value: Flag = next !== undefined && !next.startsWith("--") ? next : true;
			if (typeof value === "string") i++;
			// Repeats accumulate rather than overwrite, so `--peer a --peer b` means both.
			// Last-wins would silently honour one of two peers a user deliberately listed.
			const prev = flags[key];
			if (prev === undefined) flags[key] = value;
			else if (Array.isArray(prev)) prev.push(String(value));
			else flags[key] = [String(prev), String(value)];
		} else {
			positional.push(arg);
		}
	}
	return { positional, flags };
}

/** A flag that may appear more than once, as a list. Absent and `--flag` alike give []. */
function list(flag: Flag | undefined): string[] {
	if (Array.isArray(flag)) return flag;
	return typeof flag === "string" ? [flag] : [];
}

function humanBytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
	return `${(n / 1024).toFixed(0)} KiB`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const { positional, flags } = parseArgs(argv);
	const command = positional[0];
	if (!command || flags.help) usage();

	const baseUrl = String(flags.url ?? process.env.ANTHERS_URL ?? DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	// The authorize page is served by the site, which is the same origin as the API in
	// production and a different port in development. Defaulting it to `baseUrl` is right
	// for everyone except a developer, who has `--web` and `ANTHERS_WEB_URL`.
	const webUrl = String(flags.web ?? process.env.ANTHERS_WEB_URL ?? baseUrl).replace(/\/$/, "");

	try {
		if (command === "login") {
			const result = await login({
				baseUrl,
				webUrl,
				label: typeof flags.label === "string" ? flags.label : undefined,
				noBrowser: flags["no-browser"] === true,
				onLog: (line) => console.error(line),
			});
			const path = storeToken(result.token);
			console.error(`\nSigned in as ${result.username}. Session stored in ${path}.`);
			console.error("Revoke it any time from Settings → Devices, or run `anthersp2p logout`.");
			return 0;
		}

		if (command === "logout") {
			// Local only, and say so. Deleting the file stops THIS machine using the session;
			// it does not tell the hub to end it, and implying otherwise would leave someone
			// believing a stolen laptop had been dealt with.
			const had = clearStoredToken();
			console.error(
				had
					? "Forgot the stored session. It stays valid until you revoke it in Settings → Devices."
					: "No stored session to forget.",
			);
			return 0;
		}
	} catch (err) {
		if (err instanceof LoginError) {
			console.error(`\n  ${err.message}`);
			return 1;
		}
		throw err;
	}

	// Explicit credentials outrank the stored one: a script that passes --token is naming
	// the account it means, and silently preferring whoever last ran `login` would make it
	// act as somebody else.
	const token = String(flags.token ?? process.env.ANTHERS_TOKEN ?? readStoredToken() ?? "");
	if (!token) {
		console.error("Not signed in. Run `anthersp2p login`, or pass --token / set ANTHERS_TOKEN.");
		return 2;
	}

	const workId = positional[1];
	const assetId = Number(positional[2]);
	if (!workId || !Number.isInteger(assetId)) usage();

	try {
		if (command === "manifest") {
			const { manifest } = await fetchManifest({ baseUrl, token, workId, assetId });
			console.log(JSON.stringify(manifest, null, 2));
			return 0;
		}

		if (command === "seed") {
			const filePath = String(flags.file ?? "");
			if (!filePath) {
				console.error("seed needs --file pointing at your local copy of the asset.");
				return 2;
			}
			const seeder = await startSeeder({
				baseUrl,
				token,
				workId,
				assetId,
				filePath,
				port: flags.port ? Number(flags.port) : undefined,
				announceUrl: typeof flags.announce === "string" ? flags.announce : undefined,
				skipVerify: flags["skip-verify"] === true,
				onLog: (line) => console.error(line),
			});
			console.error(
				`seeding ${seeder.manifest.assetFilename} (${seeder.manifest.chunks.length} chunks) ` +
					`on port ${seeder.port}`,
			);
			if (!flags.announce) {
				console.error(
					"  not announced — pass --announce https://your.host to have the hub list this " +
						"seeder so downloaders find it on their own",
				);
			}
			console.error(
				"  peers present a hub-minted token; every request is verified. Ctrl-C to stop.",
			);
			// Withdraw the hub listing on the way out rather than leaving a lease pointing at
			// a host that has stopped serving. The lease would lapse on its own; this makes
			// the gap seconds instead of minutes.
			for (const signal of ["SIGINT", "SIGTERM"] as const) {
				process.on(signal, () => {
					// Await the withdrawal before exiting, or it never leaves the machine —
					// `process.exit` is immediate and a fire-and-forget request dies with the
					// process. Bounded, because a hub that is unreachable must not turn Ctrl-C
					// into a hang; the lease expires by itself either way.
					void Promise.race([
						seeder.stop(),
						new Promise((resolve) => setTimeout(resolve, 2000)),
					]).then(() => process.exit(0));
				});
			}
			// Resolve never: the process IS the service. Ctrl-C is the exit.
			await new Promise<void>(() => {});
			return 0;
		}

		if (command === "pull") {
			const { manifest } = await fetchManifest({ baseUrl, token, workId, assetId });
			const outputPath = String(
				flags.out ?? basename(manifest.assetFilename || `asset-${assetId}`),
			);

			console.error(
				`${manifest.assetFilename}  ${humanBytes(manifest.assetSize)}  ` +
					`${manifest.chunks.length} chunks  →  ${outputPath}`,
			);

			// Peers named on the command line come first — an explicit choice outranks the
			// hub's suggestion — and discovery fills in the rest unless it was turned off.
			// Neither is required: with no peers at all this is a hub download, which is the
			// supported floor rather than a degraded mode.
			const named = list(flags.peer).map((p) => p.replace(/\/$/, ""));
			const discovered =
				flags.discover === false || flags["no-discover"] === true
					? []
					: await discoverPeers({ baseUrl, token, workId, assetId });
			const peers = [...named, ...discovered.filter((p) => !named.includes(p))];
			if (peers.length > 0) {
				console.error(`  ${peers.length} peer(s): ${peers.join(", ")}`);
			}

			let lastPct = -1;
			const result = await pullAsset({
				baseUrl,
				token,
				workId,
				assetId,
				outputPath,
				peers,
				resume: flags.resume === true,
				concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
				onProgress: (done, total) => {
					const pct = Math.floor((done / total) * 100);
					// Progress to stderr so `anthersp2p manifest … | jq` stays clean and a
					// redirected pull does not fill a log with carriage returns.
					if (pct !== lastPct && process.stderr.isTTY) {
						process.stderr.write(`\r  ${pct}%  (${done}/${total} chunks)`);
						lastPct = pct;
					}
				},
			});
			if (process.stderr.isTTY) process.stderr.write("\r");

			const skipped = result.chunksSkipped
				? `, ${result.chunksSkipped} chunks already present`
				: "";
			console.error(`  verified ✓  ${humanBytes(result.bytesWritten)} written${skipped}`);
			return 0;
		}

		usage();
	} catch (err) {
		// Each of these means something different to whoever is reading, and an exit code
		// that distinguishes them is what makes the CLI scriptable.
		if (err instanceof SeedError) {
			console.error(`\n  Cannot seed: ${err.message}`);
			return 65; // EX_DATAERR — the file is wrong, not the request
		}
		if (err instanceof AccessDeniedError) {
			console.error(`\n  ${err.message}`);
			return 77; // EX_NOPERM
		}
		if (err instanceof VerificationError) {
			console.error(`\n  Integrity check failed: ${err.message}`);
			console.error("  The file on disk is not what the manifest describes. It was not completed.");
			return 65; // EX_DATAERR
		}
		console.error(`\n  ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
