// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { chapterIndexFor, splitOnTimestamps, workChapters } from "./chapters.js";

describe("splitOnTimestamps", () => {
	test("text with no timestamps stays one segment", () => {
		expect(splitOnTimestamps("No cues in here at all.")).toEqual([
			{ text: "No cues in here at all." },
		]);
	});

	test("an M:SS token inside copy parses with its seconds", () => {
		expect(splitOnTimestamps("Starts at 1:23, ends at 2:00")).toEqual([
			{ text: "Starts at " },
			{ text: "1:23", seconds: 83 },
			{ text: ", ends at " },
			{ text: "2:00", seconds: 120 },
		]);
	});

	test("an H:MM:SS token parses to its full seconds", () => {
		expect(splitOnTimestamps("The finale, 1:02:03 onward")).toEqual([
			{ text: "The finale, " },
			{ text: "1:02:03", seconds: 3723 },
			{ text: " onward" },
		]);
	});

	test("cumulative minutes past the hour still read as one number", () => {
		expect(splitOnTimestamps("75:30 of it")).toEqual([
			{ text: "75:30", seconds: 75 * 60 + 30 },
			{ text: " of it" },
		]);
	});

	test("the full H:MM:SS shape reads through — no sub-token inside it", () => {
		// The match is the whole `12:34:56`; the lookbehind keeps `2:34` and the rest
		// of its interior from reading as separate timestamps.
		expect(splitOnTimestamps("12:34:56 and a1:23")).toEqual([
			{ text: "12:34:56", seconds: 12 * 3600 + 34 * 60 + 56 },
			{ text: " and a1:23" },
		]);
	});

	test("the escape mark hides the token's backslash and its seconds", () => {
		expect(splitOnTimestamps("The \\0:43 mark is copy")).toEqual([
			{ text: "The " },
			{ text: "0:43" },
			{ text: " mark is copy" },
		]);
	});
});

describe("workChapters", () => {
	test("a description with no timestamps carries no chapters", () => {
		expect(workChapters("A quiet field recording, made in one take.")).toEqual([]);
	});

	test("Parker's same-line form: time, then title, then prose below", () => {
		expect(workChapters("0:43 Chapter 2\nStuff in the chapter")).toEqual([
			{ seconds: 43, title: "Chapter 2" },
		]);
	});

	test("Parker's mid-line lyrics form reads the label off the line", () => {
		expect(
			workChapters(
				[
					"CHORUS - 1:34",
					"Lyrics in the chorus",
					"More Lyrics",
					"",
					"VERSE 2 - 2:01",
					"Lyrics in the verse",
					"etc.",
				].join("\n"),
			),
		).toEqual([
			{ seconds: 94, title: "CHORUS" },
			{ seconds: 121, title: "VERSE 2" },
		]);
	});

	test("chapters sort by time, not by where they appear in the text", () => {
		expect(workChapters("Outro 2:00\nIntro 0:00 extra\n")).toEqual([
			{ seconds: 0, title: "Intro extra" },
			{ seconds: 120, title: "Outro" },
		]);
	});

	test("the bare-timestamp form takes the title from the line below", () => {
		expect(workChapters("0:00\nIntro\n1:30\nMiddle")).toEqual([
			{ seconds: 0, title: "Intro" },
			{ seconds: 90, title: "Middle" },
		]);
	});

	test("a repeated moment means it once — the first listing wins", () => {
		expect(workChapters("0:00 First\n0:00 Again")).toEqual([{ seconds: 0, title: "First" }]);
	});

	test("every timestamp is a cue — no minimum count, no 0:00 rule", () => {
		expect(workChapters("Somewhere at 3:15 only")).toEqual([
			{ seconds: 195, title: "Somewhere at only" },
		]);
	});

	test("an escaped token is neither a cue nor dropped from titles or copy", () => {
		expect(workChapters("The show runs \\2:30 late\nNext part 4:00")).toEqual([
			{ seconds: 240, title: "Next part" },
		]);
		// And in the rendered copy the token survives, backslash gone.
		expect(splitOnTimestamps("The show runs \\2:30 late")).toEqual([
			{ text: "The show runs " },
			{ text: "2:30" },
			{ text: " late" },
		]);
	});

	test("seconds above 59 are not a real time and leave no token behind", () => {
		expect(workChapters("12:65 is a typo")).toEqual([]);
	});
});

describe("chapterIndexFor", () => {
	const chapters = workChapters("0:00 Start\n1:30 Middle\n5:00 Late");

	test("-1 on a list whose first cue is later", () => {
		const later = workChapters("1:30 Middle");
		expect(chapterIndexFor(later, 0.5)).toBe(-1);
	});

	test("the last cue at or before the playhead", () => {
		expect(chapterIndexFor(chapters, 0)).toBe(0);
		expect(chapterIndexFor(chapters, 89)).toBe(0);
		expect(chapterIndexFor(chapters, 90)).toBe(1);
		expect(chapterIndexFor(chapters, 300)).toBe(2);
	});

	test("-1 for an empty list", () => {
		expect(chapterIndexFor([], 10)).toBe(-1);
	});
});
