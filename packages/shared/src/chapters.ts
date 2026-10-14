// SPDX-License-Identifier: Apache-2.0
/**
 * Creator-authored chapters, parsed from a Work's own description text.
 *
 * The YouTube model, Parker's direction (2026-10-13): a creator writes timestamps into
 * the description as ordinary text — `0:43 Chapter 2`, or mid-line as lyrics want,
 * `CHORUS - 1:34` — and every timestamp is a chapter cue. There is no separate chapter
 * editor, no stored data model, and no rule the list must satisfy: **the description text
 * is the single source of truth**, and everything downstream (the chapter rows, the seek
 * bar's segments, the links inside the description itself) parses it, this module's one
 * scan being the parser every surface shares.
 *
 * The one affordance is the **escape**: a `\` immediately before a timestamp-like token
 * marks it as copy rather than a cue, and the backslash itself is never rendered — the
 * token reads with it gone whether or not the surface links it. A token the creator
 * meant as a chapter and a token they escaped are the only two treatments there are;
 * nothing is inferred beyond the scan.
 *
 * ⚠️ Parsing runs at render time on both kinds of body — a Work's description (video,
 * spoken audio and music each take chapters) and, token-side only, a review's body.
 * Pure text here: no React, no player, no access logic — the players and the renderers
 * above this file own those.
 */

const MAX_CHAPTERS = 500;

/**
 * One parsed timestamp token.
 */
export interface TimestampedSegment {
	/** The text this segment renders — a timestamp reads as written, escape mark gone. */
	text: string;
	/**
	 * The token's position in the media, in seconds, when this segment IS a live
	 * timestamp — the thing a link seeks to. undefined for ordinary copy and for an
	 * escaped token, which renders as plain text.
	 */
	seconds?: number;
}

/**
 * One chapter cue: a moment in the Work and its title, which may be null — a bare
 * timestamp with nothing on its line or the line below renders as the time itself.
 */
export interface WorkChapter {
	seconds: number;
	title: string | null;
}

/**
 * A timestamp as the description writes it: where it sits, what it says and whether
 * the creator escaped it out of chaptering.
 */
interface TimestampToken {
	/** Start index in the source, INCLUDING a leading escape backslash when present. */
	start: number;
	/** End index, exclusive. */
	end: number;
	text: string;
	seconds: number;
	escaped: boolean;
}

/**
 * The timestamp shape: `M:SS` and `HH:MM:SS`, minutes allowed 2 digits so a
 * 99-minute file still reads `75:30` cumulatively. The guards around it stop the scan
 * from matching inside a longer figure: not preceded by a word character or a colon
 * (no `2:34` inside `12:34:56`), not followed by one (no `12` reading as `12:34`).
 * A leading `\` is the escape mark, included in the span so renderers can hide it.
 */
const TIMESTAMP_PATTERN = /(\\)?(?<![\w:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g;

/** Seconds for a timestamp's capture fields, or null when the digits are not a real time. */
function secondsFor(first: string, second: string, third: string | null): number | null {
	const secondValue = Number(second);
	if (secondValue > 59) return null;
	if (third == null) {
		// `75:30` is 75 minutes and 30 seconds — cumulative minutes stay legal up to
		// the two-digit cap, so files longer than an hour read as creators write them.
		return Number(first) * 60 + secondValue;
	}
	const minuteValue = Number(second);
	if (minuteValue > 59) return null;
	return Number(first) * 3600 + minuteValue * 60 + Number(third);
}

/** Scan every timestamp-shaped token in the text, escaped ones marked. */
function scanTimestamps(text: string): TimestampToken[] {
	const tokens: TimestampToken[] = [];
	for (const match of text.matchAll(TIMESTAMP_PATTERN)) {
		const withEscape = match[1] === "\\";
		const seconds = secondsFor(
			match[2] as string,
			match[3] as string,
			(match[4] as string | undefined) ?? null,
		);
		if (seconds == null) continue;
		const body = match[0].slice(withEscape ? 1 : 0);
		tokens.push({
			start: match.index as number,
			end: (match.index as number) + match[0].length,
			text: body,
			seconds,
			escaped: withEscape,
		});
	}
	return tokens;
}

/** Every timestamp in `text`, plus the copy between them, ready to render. */
export function splitOnTimestamps(text: string): TimestampedSegment[] {
	const tokens = scanTimestamps(text);
	if (tokens.length === 0) return [{ text }];
	const segments: TimestampedSegment[] = [];
	let cursor = 0;
	for (const token of tokens) {
		if (token.start > cursor) segments.push({ text: text.slice(cursor, token.start) });
		segments.push(
			token.escaped ? { text: token.text } : { text: token.text, seconds: token.seconds },
		);
		cursor = token.end;
	}
	if (cursor < text.length) segments.push({ text: text.slice(cursor) });
	return segments;
}

/**
 * The chapter list a description text carries — every unescaped timestamp, in play
 * order, with whatever the line said beside it as the title. Empty for a description
 * with no timestamps.
 */
export function workChapters(text: string): WorkChapter[] {
	if (!text) return [];
	const tokens = scanTimestamps(text);
	const cues = tokens.filter((t) => !t.escaped);
	if (cues.length === 0) return [];

	// Token offsets to their lines, so a title can be read off and cut from one.
	const lines: Array<{ start: number; end: number; text: string }> = [];
	{
		let index = 0;
		for (const line of text.split("\n")) {
			lines.push({ start: index, end: index + line.length, text: line });
			index += line.length + 1;
		}
	}
	const lineAt = (offset: number) => {
		let low = 0;
		let high = lines.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (lines[mid].start <= offset) low = mid;
			else high = mid - 1;
		}
		return low;
	};

	/**
	 * The line with its cue timestamps cut out and the surrounding punctuation
	 * (`-`, `:`, `·`, bullets) trimmed where they met a token — `CHORUS - 1:34`
	 * reads as `CHORUS`, and the cut never leaves a dangling separator.
	 */
	const strippedLine = (start: number, end: number) => {
		const pieces: string[] = [];
		let cursor = start;
		for (const token of tokens) {
			if (token.start < start || token.end > end) continue;
			if (token.start > cursor) pieces.push(text.slice(cursor, token.start));
			// An escaped token is copy, not a cue: it survives without its escape mark.
			if (token.escaped) pieces.push(token.text);
			cursor = token.end;
		}
		pieces.push(text.slice(cursor, end));
		// Whitespace collapsed, separator punctuation trimmed where it faced a cut.
		let cleaned = pieces.join(" ").replace(/\s+/g, " ").trim();
		cleaned = cleaned
			.replace(/^[-–—:·•*]+\s*/, "")
			.replace(/\s*[-–—:·•*]+$/, "")
			.trim();
		return cleaned;
	};

	const byLine = new Map<number, TimestampToken[]>();
	for (const token of cues) {
		const line = lineAt(token.start);
		const existing = byLine.get(line);
		if (existing) existing.push(token);
		else byLine.set(line, [token]);
	}

	const chapters: WorkChapter[] = [];
	const seen = new Set<number>();
	for (const [lineIndex, lineTokens] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
		const line = lines[lineIndex];
		const remainder = strippedLine(line.start, line.end);
		for (const token of lineTokens) {
			if (chapters.length >= MAX_CHAPTERS) return chapters;
			// First occurrence wins on a repeated moment — a creator listing the same
			// point twice means it once.
			if (seen.has(token.seconds)) continue;
			seen.add(token.seconds);
			let title = remainder;
			if (!title) {
				// The bare-timestamp form — `0:00` alone on its line — takes its title
				// from the first line beneath that carries content, freed of its own
				// timestamps; a line of bare timestamps yields nothing, and the row
				// then renders as the time itself.
				for (let i = lineIndex + 1; i < lines.length; i++) {
					if (!lines[i].text.trim()) continue;
					title = strippedLine(lines[i].start, lines[i].end);
					break;
				}
			}
			chapters.push({
				seconds: token.seconds,
				title: title || null,
			});
		}
	}
	// Duplicates already collapsed; render in play order regardless of where in the
	// description each cue was written.
	return chapters.sort((a, b) => a.seconds - b.seconds);
}

/**
 * The chapter playing at `seconds` — the last cue at or before it — or -1 when the
 * playhead sits on no chapter (before the first cue, or there are none).
 */
export function chapterIndexFor(chapters: WorkChapter[], seconds: number): number {
	let index = -1;
	for (let i = 0; i < chapters.length; i++) {
		if (chapters[i].seconds <= seconds) index = i;
		else break;
	}
	return index;
}
