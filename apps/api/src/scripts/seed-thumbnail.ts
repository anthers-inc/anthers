// SPDX-License-Identifier: Apache-2.0
/**
 * Give a seeded video the thumbnail its creator would have chosen, taken from a frame of its clip.
 *
 * A released video always has one: release refuses a video without (`thumbnail_missing`), and
 * nothing takes one on a creator's behalf (Parker, 2026-09-18). The seeds release their Works
 * directly rather than through that gate, so they stand in for the creator here, or a fixture
 * would be a released video in a state no real path produces.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { ffmpegCommand } from "../lib/ffmpeg.js";
import { storage } from "../services/storage/index.js";

export async function seedVideoThumbnail(
	workId: number,
	creatorId: number,
	clipPath: string,
): Promise<void> {
	const framePath = join(tmpdir(), `seed_thumbnail_${randomUUID()}.jpg`);
	try {
		const proc = Bun.spawn(
			ffmpegCommand(clipPath, ["-ss", "1", "-vframes", "1", "-q:v", "2", framePath, "-y"]),
			{ stdout: "pipe", stderr: "pipe" },
		);
		if ((await proc.exited) !== 0) {
			throw new Error(
				`could not take a frame from ${clipPath}: ${await new Response(proc.stderr).text()}`,
			);
		}
		const key = `creators/${creatorId}/thumbnails/${randomUUID().replace(/-/g, "")}.jpg`;
		await storage.upload(
			key,
			new Uint8Array(await Bun.file(framePath).arrayBuffer()),
			"image/jpeg",
			"public",
		);
		await db
			.update(works)
			.set({ thumbnail: await storage.getUrl(key) })
			.where(eq(works.id, workId));
	} finally {
		await rm(framePath, { force: true });
	}
}
