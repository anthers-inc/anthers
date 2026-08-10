// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Seed a real test file for the P2P spike.
 *
 * The gauntlet fixture's `gauntlet-paid-download.zip` asset points at a 22-byte empty zip
 * on disk. That's too small to validate chunking — a 10 MiB file with real content exercises
 * the parallel download, per-chunk hashing, and reassembly meaningfully.
 *
 * This script writes a deterministic ~10 MiB file (pseudo-random bytes from a fixed seed) to
 * the asset's storage key, so the manifest builder has real bytes to chunk. It also updates
 * the asset's `fileSize` column to match, so the manifest's fileSize is correct.
 *
 * Usage: bun run apps/api/src/spike-p2p/seed.ts
 */
import { db } from "@anthers/db/client";
import { assets } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { storage } from "../services/storage/index.js";

const TARGET_ASSET_ID = 2721; // gauntlet-paid-download asset
const FILE_SIZE = 10 * 1024 * 1024; // 10 MiB

// Deterministic pseudo-random bytes (so the file is reproducible across runs)
// Simple LCG — not cryptographic, just needs to be non-trivial content.
function generateBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let state = 0x12345678;
	for (let i = 0; i < size; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		bytes[i] = (state >> 16) & 0xff;
	}
	return bytes;
}

async function main() {
	const [asset] = await db.select().from(assets).where(eq(assets.id, TARGET_ASSET_ID)).limit(1);
	if (!asset) {
		console.error(`Asset ${TARGET_ASSET_ID} not found. Run 'make gauntlet-reset' first.`);
		process.exit(1);
	}

	console.log(`Seeding P2P spike test file for asset ${asset.id} (${asset.filename})`);
	console.log(`  Storage key: ${asset.file}`);
	console.log(`  Current size: ${asset.fileSize ?? 0} bytes`);

	const bytes = generateBytes(FILE_SIZE);
	console.log(
		`  Writing ${FILE_SIZE} bytes (${(FILE_SIZE / 1024 / 1024).toFixed(0)} MiB) to storage...`,
	);

	await storage.upload(asset.file, bytes, "application/zip", "private");

	// Update the asset's fileSize to match the real file
	await db.update(assets).set({ fileSize: FILE_SIZE }).where(eq(assets.id, asset.id));

	const sha256 = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	const hashHex = Array.from(new Uint8Array(sha256))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	console.log(`  Done. SHA-256: ${hashHex}`);
	console.log(`  Updated asset.fileSize to ${FILE_SIZE}`);
	console.log("");
	console.log("The P2P spike is ready. Start the API (make dev) and open:");
	console.log("  http://localhost:8000/api/spike-p2p/client");
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
