// SPDX-License-Identifier: Apache-2.0
/**
 * Stream a zip of stored objects without materialising the archive or the files.
 *
 * A set or build version's "download the original" is many objects, and a comic's source
 * pages can run to gigabytes. Reading them into memory to call `zipSync` is exactly the
 * shape the storage caps exist to avoid, so this walks each object in ranged chunks and
 * feeds `fflate`'s store-only zip pass: no compression CPU, no whole-file residency.
 *
 * ⚠️ **A missing or short object ends its entry rather than failing the archive.** The
 * version row is the promise; a stranded object is a storage defect, and a download that
 * refuses every other file because one is gone is worse than a zip with one short entry.
 * The route owns the owner check and the manifest; this helper only moves bytes.
 */

import { Zip, ZipPassThrough } from "fflate";
import { storage } from "../services/storage/index.js";

/** One megabyte per ranged read — large enough to keep the request count sane and small
 *  enough that a several-gigabyte page set never sits in memory. */
const CHUNK = 1024 * 1024;

export interface ZipSource {
	filename: string;
	file: string;
}

function entryName(index: number, filename: string): string {
	const safe = filename.replace(/[\\/]/g, "-").trim() || "original";
	return `${String(index + 1).padStart(2, "0")}-${safe}`;
}

export function zipStream(sources: ZipSource[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const zip = new Zip((err, data, final) => {
					if (err) {
						controller.error(err);
						return;
					}
					controller.enqueue(data);
					if (final) controller.close();
				});

				for (const [index, source] of sources.entries()) {
					const entry = new ZipPassThrough(entryName(index, source.filename));
					zip.add(entry);
					const size = await storage.size(source.file).catch(() => null);
					let offset = 0;
					if (size === 0) {
						entry.push(new Uint8Array(0), true);
						continue;
					}
					while (size == null || offset < size) {
						const chunk = await storage.readRange(source.file, offset, CHUNK);
						if (!chunk || chunk.length === 0) break;
						offset += chunk.length;
						entry.push(chunk, size != null && offset >= size);
					}
					// Unknown length or a short read: close the entry rather than leaving the
					// zip waiting for bytes that are not coming.
					if (size == null || offset < size) entry.push(new Uint8Array(0), true);
				}
				zip.end();
			} catch (err) {
				controller.error(err);
			}
		},
	});
}
