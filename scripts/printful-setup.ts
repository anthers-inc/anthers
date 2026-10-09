// SPDX-License-Identifier: Apache-2.0
/**
 * Wire one merch Work to Printful — by BINDING to a store product that already exists.
 *
 * ⚠️ **A person runs this** (the brand-codegen rule: "scripts a person runs and commits
 * the output of"). It needs `PRINTFUL_TOKEN` in the environment — from the BWS secret
 * manager, never named on a command line.
 *
 * Usage:
 *
 *     bws run -- bun run scripts/printful-setup.ts \
 *         --slug <work-slug> --store-product <printful-store-product-id>
 *
 * 🚨 **The create mode is gone.** Parker's store was built in the dashboard (2026-10-09:
 * two products, each 2 colors × 7 sizes XS–3XL, print files uploaded and priced at $30
 * there), so the script's original create-from-catalog flow would have duplicated his
 * products. Binding is read-back only: nothing is written to Printful's store — the
 * dashboard stays the one place a product, its print files, and its `retail_price` are
 * edited, and a re-run of this script restamps the rows from whatever the store now
 * carries. A price change is: edit in the dashboard, then re-run this script.
 *
 * What the bind does:
 * - reads the store product and its Sync Variants (`GET /store/products/{id}`);
 * - parses each variant's name as `"<product> / <color> / <size>"` (Printful's own
 *   dashboard naming — the probe verified the shape) and reads its `retail_price`,
 *   `variant_id` (the catalog blank), and print file (`front_large`, status `ok`);
 * - upserts the `merch_variants` rows keyed (work, color, size), stamping the Sync
 *   Variant id the order placement references (`sync_variant_id`).
 *
 * refusing to guess is the theme: a variant whose name does not parse, whose price is
 * unset, or whose print file is not `ok` is reported and SKIPPED — a partially bound
 * Work is safe (unbound sizes are simply not buyable) but a wrongly bound one is not.
 *
 * The webhook configuration is registered as the closing step when `PUBLIC_API_URL` is
 * set (one URL per store — this step is also how a moved endpoint is repointed).
 */
import { db } from "@anthers/db/client";
import { merchVariants, works } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";

const API = "https://api.printful.com";

function parseArgs() {
	const args = process.argv.slice(2);
	const get = (name: string) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? undefined : args[i + 1];
	};
	const slug = get("slug");
	const storeProduct = get("store-product");
	if (!slug || !storeProduct) {
		console.error(
			"Usage: printful-setup --slug <work-slug> --store-product <printful-store-product-id>",
		);
		process.exit(1);
	}
	return { slug, storeProduct: Number(storeProduct) };
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
	currency?: string;
	files?: Array<{ type: string; status?: string; url?: string | null; filename?: string }>;
}

interface SyncProductRow {
	id: number;
	external_id: string | null;
	name: string;
	variants: number;
}

/**
 * The webhook event types the receiver tracks, registered as the setup's closing step.
 */
async function setWebhookUrl(url: string, types: string[]): Promise<boolean> {
	try {
		await pf("POST", "/webhooks", { url, types });
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const { slug, storeProduct } = parseArgs();

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

	// The store product, fully expanded: the Sync Variants carry everything the rows need.
	const detail = await pf<{ result: { sync_product: SyncProductRow; items: SyncVariantRow[] } }>(
		"GET",
		`/store/products/${storeProduct}`,
	);
	const variants = detail.result.items;
	console.log(
		`Binding Work "${slug}" (#${work.id}) to store product ${storeProduct} "${detail.result.sync_product.name}" — ${variants.length} variant(s).`,
	);

	// The catalog blanks, for the wholesale-cost snapshot (`catalog_price`) — the
	// transparency prose's basis, never the pricing source. Looked up per catalog
	// variant id; a blank the catalog no longer carries is skipped with the rest.
	const catalogIds = [...new Set(variants.map((sv) => sv.variant_id))];
	const blanks = new Map<number, string>();
	for (const id of catalogIds) {
		try {
			const v = await pf<{ result: { variant: { id: number; price: string } } }>(
				"GET",
				`/products/variant/${id}`,
			);
			blanks.set(id, v.result.variant.price);
		} catch {
			console.error(`  catalog variant ${id} is gone from Printful's catalog — its rows skip`);
		}
	}

	// One row per (color, size), parsed from Printful's own dashboard naming.
	const SIZE_RE = /\/\s*(.+?)\s*\/\s*(XS|S|M|L|XL|2XL|3XL)\s*$/;
	let bound = 0;
	for (const sv of variants) {
		const m = sv.name.match(SIZE_RE);
		const color = m?.[1]?.trim();
		const size = m?.[2];
		if (!color || !size) {
			console.error(`  SKIP — name "${sv.name}" does not parse as "<product> / <color> / <size>"`);
			continue;
		}
		if (sv.retail_price == null) {
			console.error(`  SKIP — ${color}/${size}: the Sync Variant carries no retail_price`);
			continue;
		}
		const printFile = (sv.files ?? []).find(
			(f) => f.type === "front_large" || f.type === "default",
		);
		if (printFile?.status !== "ok") {
			console.error(
				`  SKIP — ${color}/${size}: print file is ${printFile?.status ?? "missing"} — fix it in the dashboard, then re-run`,
			);
			continue;
		}
		const blankPrice = blanks.get(sv.variant_id);
		if (blankPrice == null) continue; // already reported above
		const [existing] = await db
			.select()
			.from(merchVariants)
			.where(
				and(
					eq(merchVariants.workId, work.id),
					eq(merchVariants.color, color),
					eq(merchVariants.size, size),
				),
			)
			.limit(1);
		const values = {
			workId: work.id,
			color,
			size,
			catalogVariantId: sv.variant_id,
			syncVariantId: sv.id,
			catalogVariantName: sv.name.split("/").slice(-2).join("/").trim(),
			catalogPrice: blankPrice,
			printFileUrl: printFile.url ?? printFile.filename ?? "",
			synced: true,
		};
		if (existing) {
			await db
				.update(merchVariants)
				.set({ ...values, listPrice: sv.retail_price, updatedAt: new Date() })
				.where(eq(merchVariants.id, existing.id));
		} else {
			await db.insert(merchVariants).values({ ...values, listPrice: sv.retail_price });
		}
		bound += 1;
		console.log(
			`  ${color} / ${size}: catalog ${sv.variant_id}, sync ${sv.id}, lists at $${sv.retail_price} (blank costs $${blankPrice})`,
		);
	}

	console.log(
		`Bound ${bound}/${variants.length} variant(s). The Work's pickers read these rows; a price change is a dashboard edit + this re-run.`,
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
