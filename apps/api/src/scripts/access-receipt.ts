// SPDX-License-Identifier: Apache-2.0
/**
 * Reissue a signed access receipt into the reader's own space.
 *
 * The automatic path is the payment webhook's `access_receipts` row and the sweep that drains
 * it; this is the operator's door for the two cases the sweep cannot fix on its own: a PDS
 * that lost the record after the row said `written`, and a reader whose identity has since
 * become one Anthers can write for.
 *
 * Usage:
 *   bun run receipt:write --purchase 42
 *   bun run receipt:write --user 7
 *
 * A reissue is safe because the record is idempotent: a valid receipt at the key is left
 * alone, and only a missing or non-verifying one is written.
 */
import { db } from "@anthers/db/client";
import { purchases } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
	type ReceiptKind,
	type ReceiptWrite,
	writeAccessReceipt,
} from "../services/access-receipts.js";

interface Args {
	purchaseId: number | null;
	userId: number | null;
}

function parse(argv: string[]): Args {
	const args: Args = { purchaseId: null, userId: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--purchase") args.purchaseId = Number(argv[++i]);
		else if (arg === "--user") args.userId = Number(argv[++i]);
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.purchaseId && !args.userId) throw new Error("name --purchase <id> or --user <id>");
	if (args.purchaseId !== null && !Number.isInteger(args.purchaseId)) {
		throw new Error("--purchase takes a purchase id");
	}
	if (args.userId !== null && !Number.isInteger(args.userId)) {
		throw new Error("--user takes an account id");
	}
	return args;
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));

	let ids: number[];
	if (args.purchaseId) {
		ids = [args.purchaseId];
	} else {
		const rows = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, args.userId as number),
					inArray(purchases.status, ["completed", "refunded", "disputed"]),
				),
			);
		ids = rows.map((row) => row.id);
	}

	if (ids.length === 0) {
		console.error("no settled purchases to reissue");
		process.exitCode = 1;
		return;
	}

	let failures = 0;
	for (const purchaseId of ids) {
		const kinds: ReceiptKind[] = ["purchase", "refund"];
		for (const kind of kinds) {
			const result = await writeAccessReceipt(purchaseId, kind);
			// A refund statement on a purchase nobody refunded is an ordinary nothing.
			if (result.outcome === "skipped" && result.reason === "not_refunded") continue;
			console.log(JSON.stringify({ purchaseId, kind, ...summarize(result) }));
			if (result.outcome === "skipped") failures++;
		}
	}
	if (failures > 0) process.exitCode = 1;
}

function summarize(result: ReceiptWrite): Record<string, unknown> {
	if (result.outcome === "skipped") return { outcome: result.outcome, reason: result.reason };
	return { outcome: result.outcome, receiptId: result.receiptId, spaceUri: result.spaceUri };
}

await main();
