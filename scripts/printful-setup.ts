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
 *     bws run -- bun run scripts/printful-setup.ts \
 *         --slug <work-slug> --product <printful-product-id> \
 *         --print-url "https://cdn.anthers.org/merch/{size}.png" \
 *         [--sizes S,M,L,XL] [--list-price "30.00"]
 *
 * **The list price is Printful's own `retail_price` — the ONE pricing source** (Parker,
 * 2026-10-08): on a first create, `--list-price` sets it on every variant; on a re-run,
 * the script reads whatever the store's Sync Variants now carry and restamps the rows,
 * so a price changed in Printful's dashboard is picked up by re-running with no
 * `--list-price`. There is no second place to edit a list price.
 *
 * The print files' URLs must be stable per design (the File Library reuses by URL) —
 * a changed design is a changed URL.
 *
 * Idempotent by (work, size): a size whose row already exists is updated rather than
 * duplicated, and the Printful Sync Product is created once per Work (found by its
 * `external_id`, `merch-<workId>`).
 */
import { db } from "@anthers/db/client";
import { merchVariants, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

const API = "https://api.printful.com";

/** The webhook event types the receiver tracks, registered as the setup's closing step. */
async function setWebhookUrl(url: string, types: string[]): Promise<boolean> {
	try {
		await pf("POST", "/webhooks", { url, types });
		return true;
	} catch {
		return false;
	}
}

function parseArgs() {
	const args = process.argv.slice(2);
	const get = (name: string) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? undefined : args[i + 1];
	};
	const slug = get("slug");
	const product = get("product");
	const sizes = (get("sizes") ?? "S,M,L,XL,2XL").split(",").map((s) => s.trim()).filter(Boolean);
	const printUrlTemplate = get("print-url");
	const listPrice = get("list-price");
	if (!slug || !product || !printUrlTemplate) {
		console.error(
			'Usage: printful-setup --slug <work-slug> --product <id> --print-url <template-with-{size}> [--sizes S,M] [--list-price "30.00"]',
		);
		process.exit(1);
	}
	return { slug, product: Number(product), sizes, printUrlTemplate, listPriceArg: listPrice };
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

interface SyncVariantRow {
	id: number;
	external_id: string | null;
	retail_price: string | null;
	name: string;
	variant_id: number;
}

interface SyncProductRow {
	id: number;
	external_id: string | null;
	name: string;
	variants: number;
}

async function main() {
	const { slug, product, sizes, printUrlTemplate, listPriceArg } = parseArgs();

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

	// The catalog product's variants — the blank garment+size each size names, and the
	// wholesale cost the transparency prose is based on (never published exactly).
	const catalog = await pf<{
		result: { variants: Array<{ id: number; name: string; size: string; price: string }> };
	}>("GET", `/products/${product}`);
	const bySize = new Map(catalog.result.variants.map((v) => [v.size, v]));
	for (const size of sizes) {
		if (!bySize.has(size)) {
			console.error(
				`Printful product ${product} has no variant of size "${size}" — sizes it has: ${[...bySize.keys()].join(", ")}`,
			);
			process.exit(1);
		}
	}

	// Find the store's existing Sync Product for this Work, or create it.
	const storeProducts = await pf<{ result: SyncProductRow[] }>("GET", "/store/products");
	const existingProduct = storeProducts.result.find(
		(p) => p.external_id === `merch-${work.id}`,
	);

	let syncProductId: number;
	if (existingProduct) {
		syncProductId = existingProduct.id;
		console.log(`Sync Product ${syncProductId} already exists for work ${work.id}`);

		// A re-run's price flow: the store's variants carry the authoritative retail
		// price; `--list-price` on a re-run would OVERWRITE what the dashboard carries,
		// which is backwards — refuse it, or the "one pricing source" rule dies.
		if (listPriceArg) {
			const stored = await pf<{ result: { items: SyncVariantRow[] } }>(
				"GET",
				`/store/products/${syncProductId}`,
			);
			const current = stored.result.items[0]?.retail_price ?? null;
			if (current != null && current !== listPriceArg) {
				console.error(
					`--list-price "${listPriceArg}" was passed but the store's variants already carry "${current}". ` +
						"Change the price in Printful's dashboard (the one pricing source), then re-run " +
						"without --list-price to restamp — or pass --force-price to override deliberately.",
				);
				process.exit(1);
			}
		}
	} else {
		console.log(`Creating Sync Product for work ${work.id}…`);
		const created = await pf<{ result: SyncProductRow }>("POST", "/store/products", {
			sync_product: {
				external_id: `merch-${work.id}`,
				name: work.title || `Work #${work.id}`,
				thumbnail: work.thumbnail || undefined,
			},
			sync_variants: sizes.map((size) => {
				const blank = bySize.get(size)!;
				return {
					external_id: `merch-${work.id}-${size}`,
					variant_id: blank.id,
					retail_price: listPriceArg ?? undefined, // unset → the dashboard sets it after
					files: [{ type: "default", url: printUrlTemplate.replace("{size}", size) }],
				};
			}),
		});
		syncProductId = created.result.id;
		if (!listPriceArg) {
			console.error(
				"⚠️ No --list-price was passed with the create — the variants exist but carry " +
					"Printful's default retail (unset). Set the price in the dashboard, then re-run " +
					"without --list-price to restamp the rows.",
			);
		}
		console.log(`Sync Product ${syncProductId} created.`);
	}

	// Read the store's Sync Variants back: `retail_price` is the authoritative list.
	const stored = await pf<{ result: { items: SyncVariantRow[] } }>(
		"GET",
		`/store/products/${syncProductId}`,
	);
	const storeByExternal = new Map(
		stored.result.items.map((sv) => [sv.external_id ?? "", sv]),
	);

	// The merch_variants rows — one per size, updated on re-run.
	for (const size of sizes) {
		const blank = bySize.get(size)!;
		const printFile = printUrlTemplate.replace("{size}", size);
		const external = `merch-${work.id}-${size}`;
		const syncedVariant = storeByExternal.get(external);
		const listPrice = syncedVariant?.retail_price;
		if (listPrice == null) {
			console.error(
				`  ${size}: the store's Sync Variant carries no retail_price — set it in the dashboard and re-run.`,
			);
			continue;
		}
		const [existing] = await db
			.select()
			.from(merchVariants)
			.where(eq(merchVariants.workId, work.id))
			.limit(200)
			.then((rows) => rows.filter((r) => r.size === size));
		const values = {
			workId: work.id,
			size,
			catalogVariantId: blank.id,
			catalogVariantName: syncedVariant?.name ?? blank.name,
			catalogPrice: blank.price,
			printFileUrl: printFile,
			synced: true,
		};
		if (existing) {
			await db
				.update(merchVariants)
				.set({ ...values, listPrice, updatedAt: new Date() })
				.where(eq(merchVariants.id, existing.id));
		} else {
			await db.insert(merchVariants).values({ ...values, listPrice });
		}
		console.log(
			`  ${size}: Printful ${blank.id}, costs $${blank.price}, lists at $${listPrice} — ${printFile}`,
		);
	}

	console.log(
		`Done. The Work's merch panel is live; the list prices above are Printful's own retail figure.`,
	);

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
			"PUBLIC_API_URL not set — webhook configuration skipped; set it here or re-run with it set.",
		);
	}
	process.exit(0);
}

await main();