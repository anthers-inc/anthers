// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Print the `--project=` arguments for one half of the e2e suite.
 *
 *   bun run scripts/e2e-projects.ts hermetic   →  --project=chromium
 *   bun run scripts/e2e-projects.ts media      →  --project=setup --project=authed …
 *
 * CI runs the browser suite as two jobs — one on a bare runner with no system dependencies,
 * one in a container carrying ffmpeg and poppler — and this is what decides which project
 * belongs to which. The split itself is declared once, as `metadata.needsMedia` on each
 * project in `playwright.config.ts`; this file only reads it.
 *
 * 🚨 **The reason this is a script rather than two lists in `ci.yml`.** Playwright 1.61 has
 * no `--project` negation (`--project='!chromium'` is an error, not an inverse), so a job
 * can only ever *name* the projects it wants. Two hand-maintained lists mean a project added
 * later runs in **neither** job, and nothing anywhere says so — the suite goes on passing
 * while covering less than it did, which is the failure this codebase keeps meeting in other
 * shapes. So: one declaration, derived twice, and a **missing flag is a hard error naming
 * the project** rather than a silent omission.
 *
 * It also refuses a hermetic project that would drag a media project in behind it. Playwright
 * runs a selected project's `dependencies` automatically, so a hermetic project that gained
 * `dependencies: ["setup"]` would quietly need ffmpeg on the job that deliberately has none —
 * and would fail as a missing binary three layers down rather than as the mistake it is.
 */

import config from "../playwright.config";

type Bucket = "hermetic" | "media";

const bucket = process.argv[2] as Bucket | undefined;
if (bucket !== "hermetic" && bucket !== "media") {
	console.error("usage: e2e-projects.ts hermetic|media");
	process.exit(2);
}

const projects = config.projects ?? [];
if (projects.length === 0) {
	console.error("[e2e-projects] the config declares no projects at all — refusing to guess.");
	process.exit(1);
}

const needsMedia = new Map<string, boolean>();
const undeclared: string[] = [];

for (const project of projects) {
	const name = project.name;
	if (!name) {
		console.error("[e2e-projects] a project has no name; every project must be selectable.");
		process.exit(1);
	}
	const flag = (project.metadata as { needsMedia?: unknown } | undefined)?.needsMedia;
	if (typeof flag !== "boolean") {
		undeclared.push(name);
		continue;
	}
	needsMedia.set(name, flag);
}

if (undeclared.length > 0) {
	console.error(
		`[e2e-projects] no \`metadata.needsMedia\` on: ${undeclared.join(", ")}.\n` +
			"  Every project must say which CI job runs it, because neither job can select a\n" +
			"  project it does not name — an undeclared project would run in neither and pass\n" +
			"  by not existing. Declare it in playwright.config.ts:\n" +
			"    needsMedia: true   → the container job (ffmpeg + poppler available)\n" +
			"    needsMedia: false  → the bare-runner job (no system dependencies)",
	);
	process.exit(1);
}

// A hermetic project that depends on a media project is a media project in disguise —
// Playwright will run the dependency, in the job that has no ffmpeg.
const leaks: string[] = [];
for (const project of projects) {
	const name = project.name as string;
	if (needsMedia.get(name)) continue;
	for (const dep of project.dependencies ?? []) {
		if (needsMedia.get(dep)) leaks.push(`${name} → ${dep}`);
	}
}
if (leaks.length > 0) {
	console.error(
		`[e2e-projects] a hermetic project depends on a media one: ${leaks.join(", ")}.\n` +
			"  Playwright runs dependencies automatically, so this would need ffmpeg on the job\n" +
			"  that deliberately has none. Either mark it needsMedia: true, or drop the dependency.",
	);
	process.exit(1);
}

const selected = [...needsMedia.entries()]
	.filter(([, media]) => media === (bucket === "media"))
	.map(([name]) => name);

if (selected.length === 0) {
	console.error(`[e2e-projects] no projects in the "${bucket}" half — that cannot be right.`);
	process.exit(1);
}

console.log(selected.map((name) => `--project=${name}`).join(" "));
