// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Print the Bitwarden Secrets Manager project id for a ROLE — `prod` or `dev`.
 *
 * Exists so nothing has to commit a project UUID. Same reasoning `ci.yml` gives for keeping
 * `DO_APP_ID` in a repository variable rather than the file: an identifier is useless
 * without a token, but it is still infrastructure identity and this repo is world-readable.
 *
 * 🚨 **It takes a role rather than a project name, and that is the safety property.** It used
 * to take an arbitrary name and read one shared token, so *which project* and *whose
 * credentials* were independent — and with one machine account seeing both projects, asking
 * for the production project from a development context simply worked. Now the role picks
 * both together and cannot pick them inconsistently.
 *
 *     bun run scripts/bws-project-id.ts dev
 */

// A module rather than a global script, and not merely for tidiness: without it `name`
// collides with the DOM global of that name, top-level `await` is rejected, and the file
// cannot be typechecked at all. It went unnoticed because `scripts/` sat outside
// `bun run typecheck` until 2026-08-16.
import { BWS_PROJECTS, type BwsRole, bwsProjectId, bwsToken } from "./bws";

export {};

const arg = (Bun.argv[2] ?? "").trim();
if (arg !== "prod" && arg !== "dev") {
	console.error("bws-project-id: usage: bun run scripts/bws-project-id.ts prod|dev");
	process.exit(2);
}
const role: BwsRole = arg;

try {
	console.log(await bwsProjectId(BWS_PROJECTS[role], await bwsToken(role)));
} catch (err) {
	// The message from `bwsProjectId` names what the token could actually see, which is the
	// only way to tell "no such project" from "this account has no access to it" — Bitwarden
	// answers 404 for both.
	console.error(`bws-project-id: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
