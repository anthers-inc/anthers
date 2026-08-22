// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `drizzle-kit generate`, driven through a pty so it can run unattended.
 *
 * 🚨 Why this exists. When a table gains and loses columns in the same change, drizzle-kit
 * cannot tell an add-plus-drop from a rename, so it asks — and it asks on a **tty**, with
 * raw keypresses. Piping answers into it does nothing: the process simply waits, and a
 * `bun run db:generate` from any non-interactive context hangs until it is killed. That
 * makes the ordinary act of adding a column unautomatable, which is how this repository
 * ended up with two hand-written migrations and a snapshot two versions behind.
 *
 * ⭐ **The answers do not matter, and that is what makes driving it safe.** A rename and an
 * add-plus-drop describe the *same end state*, so the choice changes only the generated
 * SQL, never the snapshot the next diff is taken against. This script therefore accepts the
 * highlighted default for every question and prints how many it answered — and if you are
 * hand-writing the SQL anyway, the generated statements are discarded and the choice is
 * moot in both directions.
 *
 * ⚠️ Read the generated SQL before applying it. This automates the *prompt*, not the
 * judgement; a destructive statement is still destructive because a default was accepted.
 */
export {}; // top-level await needs this file to be a module

const args = process.argv.slice(2);

// `script` supplies the pty. Bun has no pty binding, and util-linux `script` is the
// portable way to give a child one while keeping its stdin reachable from here.
const inner = ["bunx", "drizzle-kit", "generate", ...args].join(" ");
const proc = Bun.spawn(["script", "-qec", inner, "/dev/null"], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const QUESTION = "created or renamed from another column?";
const DONE = ["Your SQL migration file", "No schema changes"];

let seen = "";
let answered = 0;
let settled = false;

const decoder = new TextDecoder();
const writer = proc.stdin;

const reader = proc.stdout.getReader();
const deadline = setTimeout(() => {
	if (!settled) {
		console.error("drizzle-generate: timed out waiting for drizzle-kit");
		proc.kill();
	}
}, 120_000);

while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	seen += decoder.decode(value, { stream: true });

	// One Enter per question asked so far. Counting rather than reacting to the latest
	// chunk matters because the prompt library redraws itself constantly.
	const asked = seen.split(QUESTION).length - 1;
	while (answered < asked) {
		await Bun.sleep(250);
		writer.write("\r");
		await writer.flush();
		answered++;
	}

	if (DONE.some((d) => seen.includes(d))) {
		settled = true;
		break;
	}
}

clearTimeout(deadline);
await Bun.sleep(500);
try {
	writer.end();
} catch {
	// The child may already be gone; nothing to close.
}
proc.kill();

// Built rather than written as a literal: a regex literal containing the ESC control
// character trips `noControlCharactersInRegex`, and the rule is right that an invisible
// byte in source is worth objecting to.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

// The pty output is full of cursor redraws; surface only the lines that carry an outcome.
const interesting = seen
	.split("\n")
	.map((l) => l.replace(ANSI, "").trim())
	.filter((l) => /migration file|No schema changes|[Ee]rror/.test(l));

for (const line of interesting) console.log(line);
console.log(`drizzle-generate: answered ${answered} rename question(s)`);

if (!interesting.length) {
	console.error("drizzle-generate: drizzle-kit produced no recognisable outcome");
	process.exit(1);
}
