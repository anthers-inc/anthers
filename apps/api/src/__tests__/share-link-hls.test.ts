// SPDX-License-Identifier: Apache-2.0
/**
 * A shared video plays for somebody with no account, all the way down its playlists.
 *
 * 🚨 **The share token has to reach every playlist the player fetches, not only the first.**
 * A recipient with no session gets through `requireViewerOrShareLink` by presenting the token,
 * and hls.js follows the master playlist's variant URLs exactly as written, with no way for the
 * page to add anything. So a variant URL without the token is a 401, and the video never
 * starts, although the page around it renders and the master playlist answers. A signed-in
 * viewer never meets this, because their session cookie rides every request — which is how it
 * reached production unnoticed, found by the first person to open a share link signed out.
 *
 * ⚠️ **This stores real playlists, because a test that asks for one that is not there passes on
 * a 404.** `share-links.test.ts` asserts that the master request is neither 401 nor 403, and
 * its fixture's playlist was never in storage, so it had never read one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs } from "@anthers/db/schema";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

/** The path and query of a URL the server built, so the test can follow it as a player would. */
function pathOf(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname}${parsed.search}`;
}

const id = crypto.randomUUID().slice(0, 8);
const PREFIX = `creators/share-hls-${id}/videos/hls/${id}`;
const MASTER = [
	"#EXTM3U",
	"#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
	"720p.m3u8",
	"#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480",
	"480p.m3u8",
	"",
].join("\n");
const VARIANT = (name: string) =>
	[
		"#EXTM3U",
		"#EXT-X-TARGETDURATION:6",
		"#EXTINF:6.0,",
		`${name}_000.ts`,
		"#EXT-X-ENDLIST",
		"",
	].join("\n");
const FILES = {
	"master.m3u8": MASTER,
	"720p.m3u8": VARIANT("720p"),
	"480p.m3u8": VARIANT("480p"),
};

describe("a shared video, signed out", () => {
	let workId: number;
	let token: string;

	beforeAll(async () => {
		const sharer = await createAccount(`slh_sharer_${id}`);
		const creator = await createAccount(`slh_creator_${id}`);

		for (const [file, text] of Object.entries(FILES)) {
			await storage.upload(
				`${PREFIX}/${file}`,
				new TextEncoder().encode(text),
				"application/vnd.apple.mpegurl",
				"private",
			);
		}
		const work = await insertWork({
			creatorId: creator.userId,
			type: "video",
			title: "Shared video",
			streamEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		workId = work.id;
		await db.insert(transcodingJobs).values({
			workId,
			mediaType: "video",
			status: "completed",
			hlsManifestUrl: await storage.getUrl(`${PREFIX}/master.m3u8`),
		});

		const res = await req(`/api/content/works/${workId}/share-link`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: sharer.cookie },
		});
		expect(res.status).toBe(201);
		token = (await res.json()).token;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// The Work, its transcode and the link go with the creator's and sharer's accounts.
		await storage.deletePrefix(`creators/share-hls-${id}/`);
	});

	/** The URI lines of a playlist, which are what a player requests next. */
	function uris(playlist: string): string[] {
		return playlist.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
	}

	it("carries the token onto every variant playlist the master points at", async () => {
		const res = await req(`/api/content/works/${workId}/hls/master.m3u8?share=${token}`);
		expect(res.status).toBe(200);
		const variants = uris(await res.text());
		expect(variants).toHaveLength(2);
		for (const url of variants) {
			expect(new URL(url).searchParams.get("share")).toBe(token);
		}
	});

	it("serves each variant playlist to the recipient, exactly as the master listed it", async () => {
		const master = await (
			await req(`/api/content/works/${workId}/hls/master.m3u8?share=${token}`)
		).text();
		for (const url of uris(master)) {
			const res = await req(pathOf(url));
			expect(res.status).toBe(200);
			// A media playlist hands its segments out as signed storage URLs, which need
			// nothing from the recipient, so this is the last request the token has to reach.
			expect(uris(await res.text())).toHaveLength(1);
		}
	});

	it("refuses the same variant playlist without the token, which is why it has to travel", async () => {
		const res = await req(`/api/content/works/${workId}/hls/720p.m3u8`);
		expect(res.status).toBe(401);
	});
});
