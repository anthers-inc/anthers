// SPDX-License-Identifier: Apache-2.0
/**
 * Wire one merch Work to Printful: create the Sync Product (with one Sync Variant per
 * size), and write the `merch_variants` rows that make the Work buyable.
 *
 * ⚠️ **A person runs this** (the brand-codegen rule: "scripts a person runs and commits
 * the output of"). It needs `PRINTFUL_TOKEN` in the environment — from the BWS secret
 * manager, never named on a command line — and the Printful store must be of the
 * "Manual orders / API" type, created in Printful's dashboard (no API endpoint creates
 * a store).
 *
 * Usage:
 *
 *     bun run scripts/printful-setup.ts --slug <work-slug> --product <printful-product-id> [--sizes S,M,L,XL] [--base-url <print-file origin>]
 *
 * The print files are the Work's logo art served from Anthers' public bucket: the URL
 * must be stable per design (the File Library reuses by URL), so the script reads a
 * `--print-url` template like `https://cdn.anthers.org/merch/{size}.png` — a changed
 * design is a changed URL.
 *
 * Idempotent by (work, size): a size whose row already exists is updated rather than
 * duplicated, and the Printful Sync Product is created once per Work (found by its
 * `external_id`, `merch-<workId>`).
 */
import { db } from "@anthers/db/client";
import { merchVariants, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

const API = "https://api.printful.com";

function parseArgs() {
	const args = process.argv.slice(2);
	const get = (name: string) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? undefined : args[i + 1];
	};
	const slug = get("slug");
	const product = get("product");
	const sizes = (get("sizes") ?? "S,M,L,XL,2XL")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const printUrlTemplate = get("print-url");
	if (!slug || !product || !printUrlTemplate) {
		console.error(
			"Usage: printful-setup --slug <work-slug> --product <id> --print-url <template-with-{size}> [--sizes S,M]",
		);
		process.exit(1);
	}
	return { slug, product: Number(product), sizes, printUrlTemplate };
}

function token(): string {
	const t = process.env.PRINTFUL_TOKEN?.trim();
	if (!t) {
		console.error(
			"PRINTFUL_TOKEN is not set — run through `bws run --` so the secret rides the environment.",
		);
		process.exit(1);
	}
	return t;
}

async function pf<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token()}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const json = (await res.json().catch(() => null)) as { code: number; result: T } | null;
	if (!res.ok) {
		console.error(`Printful ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
		process.exit(1);
	}
	return (json as { code: number; result: T }).result;
}

async function main() {
	const { slug, product, sizes, printUrlTemplate } = parseArgs();

	const [work] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
	if (!work) {
		console.error(`No Work with slug "${slug}"`);
		process.exit(1);
	}
	if (work.type !== "physical") {
		console.error(
			`Work "${slug}" is type ${work.type}, not physical — a merch Work is type physical`,
		);
		process.exit(1);
	}

	// The product's variants, from the catalog — the blank garment+size the sizes name.
	const catalog = await pf<{
		result: { variants: Array<{ id: number; name: string; size: string; price: string }> };
	}>("GET", `/products/${product}`);
	const bySize = new Map(catalog.result.variants.map((v) => [v.size, v]));

	// One Sync Product per Work, one Sync Variant per size. external_id is the stable
	// name: `merch-<workId>-<size>` for variants, `merch-<workId>` for the product.
	const syncProduct = await pf<{ result: { id: number } }>("POST", "/store/products", {
		sync_product: {
			external_id: `merch-${work.id}`,
			name: work.title || `Work #${work.id}`,
			thumbnail: work.thumbnail || undefined,
		},
		sync_variants: sizes.map((size) => {
			const blank = bySize.get(size);
			if (!blank) {
				console.error(
					`Printful product ${product} has no variant of size "${size}" — sizes it has: ${[...bySize.keys()].join(", ")}`,
				);
				process.exit(1);
			}
			return {
				external_id: `merch-${work.id}-${size}`,
				variant_id: blank.id,
				retail_price: undefined, // the retail price is Anthers', set per-size after the margin decision
				files: [{ type: "default", url: printUrlTemplate.replace("{size}", size) }],
			};
		}),
	});
	console.log(`Sync Product ${syncProduct.result.id} created for work ${work.id}`);

	// The merch_variants rows — one per size, updated on re-run.
	for (const size of sizes) {
		const blank = bySize.get(size)!;
		const printFile = printUrlTemplate.replace("{size}", size);
		const [existing] = await db
			.select()
			.from(merchVariants)
			.where(eq(merchVariants.workId, work.id))
			.limit(200)
			.then((rows) => rows.filter((r) => r.size === size));
		if (existing) {
			await db
				.update(merchVariants)
				.set({
					catalogVariantId: blank.id,
					catalogVariantName: blank.name,
					catalogPrice: blank.price,
					printFileUrl: printFile,
					synced: true,
					updatedAt: new Date(),
				})
				.where(eq(merchVariants.id, existing.id));
		} else {
			await db.insert(merchVariants).values({
				workId: work.id,
				size,
				catalogVariantId: blank.id,
				catalogVariantName: blank.name,
				catalogPrice: blank.price,
				printFileUrl: printFile,
				synced: true,
			});
		}
		console.log(`  ${size}: catalog variant ${blank.id} at $${blank.price} — ${printFile}`);
	}

	console.log(`Sync Product created for work "${slug}" (work id ${work.id})`);
	console.log("Done. The Work's merch panel is live; the margin constant prices the list.");

	// The webhook configuration — the same person-runs-it step, pointed at this API's
	// receiver. Only one URL is active per store, so this step is also how a moved
	// endpoint is repointed.
	const webhookBase = process.env.PUBLIC_API_URL?.trim();
	if (webhookBase) {
		const ok = await setWebhookUrl(`${webhookBase}/api/webhooks/printful`, [
			"package_shipped",
			"package_returned",
			"order_created",
			"order_updated",
			"order_failed",
			"order_canceled",
			"order_put_hold",
			"order_remove_hold",
			"order_refunded",
		]);
		console.log(
			ok ? "Webhook configuration set." : "Webhook configuration FAILED — set it in the dashboard.",
		);
	} else {
		console.log(
			"PUBLIC_API_URL not set — webhook configuration skipped; set it in Printful's dashboard or re-run with it set.",
		);
	}
	process.exit(0);
}

await main();
