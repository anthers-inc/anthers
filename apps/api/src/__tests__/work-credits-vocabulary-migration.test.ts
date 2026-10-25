// SPDX-License-Identifier: Apache-2.0
/**
 * The first-edition credits vocabulary rewrite, proven against real rows.
 *
 * 🚨 The migration `…_credits_generated_vocabulary.sql` is hand-authored jsonb surgery, so
 * its claim needs what every other absence/presence claim here needs: a test. The suites
 * migrate an empty session DB before any test runs, so the transform never exercises
 * itself — this file stages legacy-vocabulary credits, re-runs the migration's own UPDATE
 * statement read verbatim from the file (a copy here would drift), and asserts every rule
 * of the rewrite's case matrix, including the ones a wrong version would silently mis-map:
 * an unnamed licensed import is DROPPED, not kept; a named `ai` row gains `created`, not
 * only `generated`; and a Work already carrying only current-vocabulary rows is untouched
 * (the statement's own WHERE filter keeps the pass a no-op for them).
 *
 * The legacy strings are cast at the fixture boundary (`as unknown as WorkCredit[]`)
 * because the type stopped carrying them — staging the old vocabulary is exactly the one
 * place that cast is honest here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import type { WorkCredit } from "@anthers/db/schema";
import { works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

const MIGRATION = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"db",
	"drizzle",
	"20261016-212917_credits_generated_vocabulary.sql",
);

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

describe("the credits vocabulary migration", () => {
	it("rewrites every first-edition row per the settled rules", async () => {
		const account = await createAccount(`credmig_${RUN}`, { fields: { creatorMode: true } });
		const statement = readFileSync(MIGRATION, "utf8");

		// The case matrix, one Work carrying every row shape side by side.
		const combined = await insertWork({
			creatorId: account.userId as number,
			type: "image",
			credits: [
				{ role: "Written by", contributor: "The Author", types: ["created"] },
				{ role: "Cover art", contributor: "", types: ["ai"] },
				{ role: "Stock music", contributor: "", types: ["licensed"] },
				{ role: "Arrangement", contributor: "The Arranger", types: ["licensed"] },
				{ role: "Blended art", contributor: "The Artist", types: ["created", "ai"] },
				{
					role: "Composed with a license",
					contributor: "The Composer",
					types: ["created", "licensed"],
				},
				{ role: "Licensed AI art", contributor: "The Studio", types: ["licensed", "ai"] },
				{ role: "Named machine cue", contributor: "The Performer", types: ["ai"] },
				{
					role: "Everything at once",
					contributor: "The One",
					types: ["created", "licensed", "ai"],
				},
			] as unknown as WorkCredit[],
		});
		const currentVocabulary = await insertWork({
			creatorId: account.userId as number,
			type: "image",
			credits: [
				{ role: "Written by", contributor: "The Author", types: ["created"] },
				{ role: "Cover art", contributor: "", types: ["generated"] },
				{ role: "Blended", contributor: "The Artist", types: ["generated", "created"] },
			],
		});

		await db.execute(sql.raw(statement));

		const [rewritten] = await db
			.select({ credits: works.credits })
			.from(works)
			.where(eq(works.id, combined.id));
		expect(rewritten.credits).toEqual([
			{ role: "Written by", contributor: "The Author", types: ["created"] },
			{ role: "Cover art", contributor: "", types: ["generated"] },
			// A named licensed row credits its named maker — the contract behind it is not the reader's business.
			{ role: "Arrangement", contributor: "The Arranger", types: ["created"] },
			{ role: "Blended art", contributor: "The Artist", types: ["created", "generated"] },
			{ role: "Composed with a license", contributor: "The Composer", types: ["created"] },
			{ role: "Licensed AI art", contributor: "The Studio", types: ["created", "generated"] },
			// A named row gains the human claim it names, blended with what remains.
			{ role: "Named machine cue", contributor: "The Performer", types: ["created", "generated"] },
			{ role: "Everything at once", contributor: "The One", types: ["created", "generated"] },
		] satisfies WorkCredit[]);
		// The unnamed licensed import row (Stock music) is gone — it asserts nothing now.
		expect(rewritten.credits?.some((c) => c.role === "Stock music")).toBe(false);

		const [untouched] = await db
			.select({ credits: works.credits })
			.from(works)
			.where(eq(works.id, currentVocabulary.id));
		expect(untouched.credits ?? null).toEqual([
			{ role: "Written by", contributor: "The Author", types: ["created"] },
			{ role: "Cover art", contributor: "", types: ["generated"] },
			{ role: "Blended", contributor: "The Artist", types: ["generated", "created"] },
		]);
	});

	it("drops an unnamed licensed import rather than keeping a credit asserting nothing", async () => {
		const account = await createAccount(`credmig_drop_${RUN}`, { fields: { creatorMode: true } });
		const statement = readFileSync(MIGRATION, "utf8");
		const work = await insertWork({
			creatorId: account.userId as number,
			type: "image",
			credits: [
				{ role: "Stock sounds", contributor: "", types: ["licensed"] },
			] as unknown as WorkCredit[],
		});
		await db.execute(sql.raw(statement));
		const [row] = await db
			.select({ credits: works.credits })
			.from(works)
			.where(eq(works.id, work.id));
		expect(row.credits ?? null).toEqual([]);
	});
});
