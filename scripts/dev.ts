// SPDX-License-Identifier: Apache-2.0
/**
 * The root dev entry point: the portless workspace runner, except under the escape hatch.
 *
 * ⚠️ **The escape hatch cannot resolve through `portless` itself.** `PORTLESS=0 bun run dev`
 * means portless runs the checkout's own `dev` script directly, and the root script *is*
 * `portless` — the resolution recursed into itself until the environment overflowed
 * (`E2BIG`), which is how `make dev` died when this file was the script named `dev`. The
 * wrapper answers the same env portless reads, and runs the workspaces' own `dev` scripts the
 * way everything did before the proxy landed: the API on :8000, the site on :3000 and the
 * admin app on :3001.
 *
 * The loopback shape matters by itself, not only as an escape: the Bluesky round trip's
 * redirect is a literal `127.0.0.1:8000`, and behind the proxy nothing sits there. Walking
 * that door by hand is what this mode is for — see `apps/api/src/lib/bluesky-door.ts`.
 * `PORTLESS=skip` and `PORTLESS=false` take the same branch, being the spellings portless
 * itself accepts.
 */
const escaped = ["0", "false", "skip"].includes(process.env.PORTLESS ?? "");

// The escape's target is the pre-proxy launcher: every workspace's own dev script. Without
// the escape, the proxy's workspace runner is what runs, reached directly — never through
// this script again, whose own named script (`dev`) is what the recursion died on.
const entry = escaped ? ["bun", "run", "--filter", "*", "dev"] : ["portless"];

const child = Bun.spawn(entry, { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" });

// Forward the group's signals to what actually runs; `make down` addresses the session's
// process group, which reaches this process and the children it raised alike — but a shell
// that interrupted only this file should still leave nothing running.
let forwarded = false;
const forward = () => {
	if (forwarded || child.pid === undefined) return;
	forwarded = true;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		// Nothing left to stop.
	}
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, forward);

const code = await child.exited;
// A signal addressed the group; the child's own exit is whatever it answered that with.
process.exit(forwarded ? code || 130 : code);
