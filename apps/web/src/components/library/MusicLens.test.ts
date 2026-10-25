// SPDX-License-Identifier: Apache-2.0
//
// The music lens's two layers in pure form: a saved Project is one release, saved tracks
// group under the Project they came from, and a track with no Project stands as a
// one-track release. The rule this pins is that the Library opens only what is on the
// Library — a release reached through saved tracks carries exactly those tracks — while a
// saved Project carries the whole record.
import { describe, expect, test } from "bun:test";
import type { Work, WorkRelease } from "@anthers/web-shared/types";
import { type LensItem, musicReleases, releasesForScope } from "./MusicLens";

function release(id: number, title: string, musicCount: number, audioCount = 0): WorkRelease {
	return {
		id,
		slug: `project-${id}`,
		title,
		coverImage: `cover-${id}.jpg`,
		creatorId: 10,
		creatorHandle: "maker",
		creatorDisplayName: "The Maker",
		musicCount,
		audioCount,
	};
}

function workItem(
	id: number,
	type: "music" | "audio" | "video",
	title: string,
	releases: WorkRelease[] = [],
): LensItem {
	return {
		id,
		kind: "work",
		hidden: false,
		purchased: false,
		work: {
			id,
			type,
			title,
			thumbnail: `thumb-${id}.jpg`,
			creatorId: 10,
			creatorHandle: "maker",
			creatorDisplayName: "The Maker",
			releases,
		} as unknown as Work,
	};
}

function projectItem(id: number, title: string, musicCount: number, audioCount = 0): LensItem {
	return {
		id: id + 100,
		kind: "project",
		hidden: false,
		purchased: false,
		project: {
			...release(id, title, musicCount, audioCount),
			trackCount: musicCount + audioCount,
		},
	};
}

describe("musicReleases", () => {
	test("a saved Project is one release, whatever else is saved from it", () => {
		const releases = musicReleases(
			[
				projectItem(1, "The Record", 4),
				workItem(11, "music", "Track 1", [release(1, "The Record", 4)]),
			],
			false,
		);

		expect(releases).toHaveLength(1);
		expect(releases[0]).toMatchObject({
			key: "project:1",
			kind: "project",
			title: "The Record",
			trackCount: 4,
			wholeRelease: true,
		});
	});

	test("a saved track groups under its Project, and only the saved tracks ride", () => {
		const releases = musicReleases(
			[workItem(12, "music", "Track 2", [release(1, "The Record", 4)])],
			false,
		);

		expect(releases).toHaveLength(1);
		expect(releases[0]).toMatchObject({
			key: "project:1",
			kind: "project",
			title: "The Record",
			trackCount: 1,
			wholeRelease: false,
		});
		expect(releases[0].tracks.map((track) => track.title)).toEqual(["Track 2"]);
	});

	test("two saved tracks from the same Project share one release, in Library order", () => {
		const releases = musicReleases(
			[
				workItem(12, "music", "Track 2", [release(1, "The Record", 4)]),
				workItem(14, "music", "Track 4", [release(1, "The Record", 4)]),
			],
			false,
		);

		expect(releases).toHaveLength(1);
		expect(releases[0].trackCount).toBe(2);
		expect(releases[0].tracks.map((track) => track.title)).toEqual(["Track 2", "Track 4"]);
	});

	test("a saved track with no Project is a one-track release", () => {
		const releases = musicReleases([workItem(21, "music", "A Loose Single")], false);

		expect(releases).toHaveLength(1);
		expect(releases[0]).toMatchObject({
			key: "work:21",
			kind: "work",
			title: "A Loose Single",
			trackCount: 1,
			wholeRelease: true,
		});
		expect(releases[0].tracks.map((track) => track.title)).toEqual(["A Loose Single"]);
	});

	test("a Work in more than one Project is one track in each release, never a loose row", () => {
		const releases = musicReleases(
			[
				workItem(31, "music", "Shared Track", [
					release(1, "The Record", 4),
					release(2, "The Best Of", 9),
				]),
			],
			false,
		);

		expect(releases.map((r) => r.title)).toEqual(["The Record", "The Best Of"]);
		expect(releases.every((r) => r.trackCount === 1)).toBe(true);
	});

	test("the include-spoken dial widens a saved Project's count to its audio members", () => {
		const mixed = projectItem(4, "A Mixed Release", 2, 1);

		expect(musicReleases([mixed], false)[0].trackCount).toBe(2);
		expect(musicReleases([mixed], true)[0].trackCount).toBe(3);
	});

	test("a Project with no music is not a release", () => {
		expect(musicReleases([projectItem(3, "A Game", 0)], true)).toEqual([]);
	});

	test("the include-spoken dial adds episodes as one-track releases, not as a series", () => {
		const episode = workItem(41, "audio", "An Episode", [release(1, "The Record", 4)]);

		expect(musicReleases([episode], false)).toEqual([]);
		const releases = musicReleases([episode], true);
		expect(releases).toHaveLength(1);
		expect(releases[0]).toMatchObject({
			key: "work:41",
			kind: "work",
			title: "An Episode",
			trackCount: 1,
		});
	});

	test("a Project's saved track can arrive before its own Library entry and is upgraded", () => {
		const releases = musicReleases(
			[
				workItem(11, "music", "Track 1", [release(1, "The Record", 3)]),
				projectItem(1, "The Record", 3),
			],
			false,
		);

		expect(releases).toHaveLength(1);
		expect(releases[0].wholeRelease).toBe(true);
		expect(releases[0].trackCount).toBe(3);
	});

	test("a feed-scoped release advertises the whole record, not just what arrived", () => {
		// A feed-shaped scope opens a release whole, so one track arriving in the stream must not
		// present a four-track record as a single.
		const reached = musicReleases(
			[workItem(12, "music", "Track 2", [release(1, "The Record", 4)])],
			false,
		);

		expect(reached[0].trackCount).toBe(1);
		expect(releasesForScope(reached, "library")[0].trackCount).toBe(1);
		expect(releasesForScope(reached, "feed")[0].trackCount).toBe(4);
	});

	test("a feed-scoped one-track release still counts itself", () => {
		const single = musicReleases([workItem(21, "music", "A Loose Single")], false);

		expect(releasesForScope(single, "feed")[0].trackCount).toBe(1);
	});
});
