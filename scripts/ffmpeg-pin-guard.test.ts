// SPDX-License-Identifier: Apache-2.0
//
// Both images get their FFmpeg from one pinned static build, and nothing else installs one.
//
// 🚨 **This is the guard the pin cannot provide for itself.** `scripts/install-ffmpeg.sh`
// refuses to install anything whose version is not the one it pins, and the image builds run
// it — but nothing inside either Dockerfile can notice a second `apt-get install ffmpeg`
// added three lines below, a Dockerfile that stops calling the installer, or a pin change
// that never rebuilds the CI image. Those are edits made *next to* the mechanism rather than
// inside it, which is the failure `dockerfile-workspaces.test.ts` records in its own history:
// the warning was in the file being edited and it still went past two people.
//
// ⭐ **A source scan rather than a live build**, for the same reason `ci-image-auth-guard`
// scans: the question is whether the files still say what they are supposed to, and that is
// answerable in a second without Docker, a runner or a network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const INSTALLER = "scripts/install-ffmpeg.sh";
const IMAGES = ["apps/api/Dockerfile", ".github/ci-image/Dockerfile"];

function read(path: string): string {
	return readFileSync(join(REPO, path), "utf8");
}

/** A `NAME="value"` declaration in the installer, which is the only place the build is written down. */
function pin(name: string): string {
	const match = read(INSTALLER).match(new RegExp(`^${name}="([^"]*)"$`, "m"));
	if (!match) throw new Error(`${INSTALLER} no longer declares ${name}`);
	return match[1] as string;
}

/** A Dockerfile with its comment lines dropped, so prose about a package cannot read as an install of it. */
function instructions(path: string): string {
	return read(path)
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/** Every `apt-get install` invocation in a Dockerfile, joined across its line continuations. */
function aptInstalls(path: string): string[] {
	return instructions(path)
		.replace(/\\\n/g, " ")
		.split("\n")
		.filter((line) => line.includes("apt-get install"));
}

describe("the pinned FFmpeg build", () => {
	test("names a static tarball over https with a sha256", () => {
		expect(pin("FFMPEG_TARBALL_URL")).toMatch(/^https:\/\/\S+\.tar\.xz$/);
		expect(pin("FFMPEG_TARBALL_SHA256")).toMatch(/^[0-9a-f]{64}$/);
	});

	test("the URL names the build the version string asserts", () => {
		// `n8.1.3-27-g8dca1586f4-20261031` → the asset is `ffmpeg-n8.1.3-27-g8dca1586f4-*`,
		// so a URL edited without its version (or the reverse) is caught here rather than at
		// a build, where the sha256 would blame the download instead of the edit.
		const build = pin("FFMPEG_VERSION").replace(/-\d{8}$/, "");
		expect(pin("FFMPEG_TARBALL_URL")).toContain(`ffmpeg-${build}`);
	});

	test("the installer refuses a binary that is not the pinned version", () => {
		expect(read(INSTALLER)).toContain('for line in "$installed_ffmpeg" "$installed_ffprobe"');
		expect(read(INSTALLER)).toContain('[ "$actual" = "$FFMPEG_VERSION" ]');
	});
});

describe("both images install FFmpeg through the shared installer", () => {
	for (const image of IMAGES) {
		test(`${image} runs ${INSTALLER}`, () => {
			expect(instructions(image)).toContain(`COPY ${INSTALLER} `);
			expect(instructions(image)).toMatch(/RUN sh \S*install-ffmpeg\.sh/);
		});

		test(`${image} installs no FFmpeg from the distribution`, () => {
			const offending = aptInstalls(image).filter((line) => /\bffmpeg\b/.test(line));
			expect(
				offending,
				`${image} installs ffmpeg with apt, which is the floating build the pin exists to replace: ` +
					offending.join(" / "),
			).toEqual([]);
		});
	}
});

describe("the CI image is rebuilt when the pin moves", () => {
	test("the installer is a path trigger on both the push and pull-request filters", () => {
		// A pin change touches `scripts/`, not `.github/ci-image/**`, so without this the
		// published image would keep running the old encoder while the API image built from
		// the same commit moved — the drift the pin exists to close, reintroduced by the
		// workflow that publishes the other half.
		const triggers = read(".github/workflows/ci-image.yml").match(/"scripts\/install-ffmpeg\.sh"/g);
		expect(triggers?.length ?? 0).toBe(2);
	});
});

describe("the CI jobs compare the build rather than printing it", () => {
	test("both media jobs hold the binary to the build the image recorded", () => {
		const ci = read(".github/workflows/ci.yml");
		const record = pin("FFMPEG_RECORD");
		const reads = ci.match(/ffmpeg -version \| head -1/g) ?? [];
		const guards = ci.match(/if \[ -f "\$record" \]/g) ?? [];
		const comparisons = ci.match(/if \[ "\$installed" != "\$recorded" \]/g) ?? [];
		expect(reads.length, "one media-tools step per job").toBe(2);
		expect(guards.length, "each step tolerates an image published before the record file").toBe(2);
		expect(comparisons.length, `each step reads ${record} and compares`).toBe(2);
		expect(ci.split(record).length - 1, `both steps read ${record}`).toBe(2);
	});
});
