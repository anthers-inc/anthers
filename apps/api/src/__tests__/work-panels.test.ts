// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the `/works/:id/panels` GET/PATCH routes.
 *
 * GET returns panel geometry for the whole Work, grouped by page. PATCH replaces one
 * page's panels atomically, clears `auto`, and validates normalized bounds.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { transcodingJobs, users, workPages, workPanels, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq } from "drizzle-orm";
import app from "../index";
import { rasterizeEbook } from "../jobs/rasterize-ebook.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
const ORIGIN = "http://localhost:3000";

function call(method: string, path: string, body?: unknown, cookie = "") {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

async function makePdfWithPanels(pages: number): Promise<{ path: string; sourceKey: string }> {
	const dir = await mkdtemp(join(tmpdir(), `panels_${RUN}_`));
	const pdfPath = join(dir, `fixture_${RUN}.pdf`);

	// Build a minimal, valid multi-page PDF by hand. Each page is 400x600 points and draws
	// two black rectangles stacked with a white gutter, which the detector should split
	// into two panels.
	const pageWidth = 400;
	const pageHeight = 600;
	const gutter = 20;
	const panelHeight = Math.floor((pageHeight - 3 * gutter) / 2);
	const panelWidth = pageWidth - 2 * gutter;

	const objects: string[] = [];
	const kids: string[] = [];
	for (let i = 0; i < pages; i++) {
		const contentId = 4 + i * 2;
		const pageId = 3 + i * 2;
		kids.push(`${pageId} 0 R`);
		const top = `${gutter} ${gutter + panelHeight + gutter} ${panelWidth} ${panelHeight} re f`;
		const bottom = `${gutter} ${gutter} ${panelWidth} ${panelHeight} re f`;
		const stream = `${top}\n${bottom}`;
		objects.push(
			`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
				`/Resources << /Font << /F1 1 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
		);
		objects.push(
			`${contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
		);
	}
	const header = "%PDF-1.4\n";
	const font = "1 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
	const pagesObj = `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>\nendobj\n`;
	const catalogId = 3 + pages * 2;
	const catalog = `${catalogId} 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
	const body = header + font + pagesObj + objects.join("") + catalog;
	const trailer = `trailer\n<< /Size ${catalogId + 1} /Root ${catalogId} 0 R >>\nstartxref\n0\n%%EOF\n`;
	await Bun.write(pdfPath, body + trailer);

	const sourceKey = `creators/${creatorId}/comics/panels_${RUN}.pdf`;
	await storage.upload(
		sourceKey,
		new Uint8Array(await Bun.file(pdfPath).arrayBuffer()),
		"application/pdf",
		"private",
	);
	return { path: pdfPath, sourceKey };
}

let creatorId = 0;
let cookie = "";
let workId = 0;
let pdfPath: string | null = null;

describe("/works/:id/panels", () => {
	beforeAll(async () => {
		const account = await createAccount(`panels_${RUN}`, { fields: { isCreator: true } });
		creatorId = account.userId as number;
		cookie = account.cookie;
		const res = await call(
			"POST",
			"/api/content/works",
			{ type: "comic", title: `Panels ${RUN}` },
			cookie,
		);
		expect(res.status).toBe(201);
		const { work } = (await res.json()) as { work: { id: number } };
		workId = work.id;

		const { sourceKey, path } = await makePdfWithPanels(2);
		pdfPath = path;
		await db
			.update(works)
			.set({
				sourceKey,
				visibility: "released",
				maturity: "general",
				maturityRows: rowsRatedAs("general"),
				maturitySource: "creator",
				seedAccess: [{ threshold: 0, allow: true, price: "0" }],
				credits: [{ role: "Made by", contributor: "The Fixture Creator", types: ["created"] }],
				releasedAt: new Date(),
				streamEnabled: true,
			})
			.where(eq(works.id, workId));
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "ebook", status: "pending", progress: 0 })
			.returning({ id: transcodingJobs.id });
		await rasterizeEbook({ jobId: job.id });
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (pdfPath) {
			const dir = pdfPath.replace(/\/[^/]+$/, "");
			await rm(dir, { recursive: true, force: true });
		}
		await storage.deletePrefix(`creators/${creatorId}/comics/panels_${RUN}`);
		await db.delete(works).where(eq(works.creatorId, creatorId));
		await db.delete(users).where(eq(users.id, creatorId));
	});

	it("GET returns the detected panels for every page", async () => {
		const res = await call("GET", `/api/content/works/${workId}/panels`, undefined, cookie);
		expect(res.status).toBe(200);
		const { pages } = (await res.json()) as {
			pages: Array<{
				pageNumber: number;
				width: number;
				height: number;
				panels: Array<{
					panelNumber: number;
					x: number;
					y: number;
					width: number;
					height: number;
					auto: boolean;
				}>;
			}>;
		};
		expect(pages.length).toBe(2);
		for (const page of pages) {
			expect(page.width).toBeGreaterThan(0);
			expect(page.height).toBeGreaterThan(0);
			expect(page.panels.length).toBe(2);
			expect(page.panels[0].auto).toBe(true);
		}
	});

	it("PATCH replaces a page's panels and clears auto", async () => {
		const body = {
			pageNumber: 1,
			panels: [
				{ x: 0, y: 0, width: 0.5, height: 1 },
				{ x: 0.5, y: 0, width: 0.5, height: 1 },
			],
		};
		const res = await call("PATCH", `/api/content/works/${workId}/panels`, body, cookie);
		expect(res.status).toBe(200);

		const stored = await db
			.select()
			.from(workPanels)
			.leftJoin(workPages, eq(workPanels.pageId, workPages.id))
			.where(eq(workPages.workId, workId))
			.orderBy(workPages.pageNumber, workPanels.panelNumber);
		const pageOne = stored.filter((r) => r.work_pages?.pageNumber === 1);
		expect(pageOne.length).toBe(2);
		expect(pageOne[0].work_panels.auto).toBe(false);
	});

	it("PATCH refuses a panel with zero size", async () => {
		const res = await call(
			"PATCH",
			`/api/content/works/${workId}/panels`,
			{ pageNumber: 1, panels: [{ x: 0, y: 0, width: 0, height: 1 }] },
			cookie,
		);
		expect(res.status).toBe(400);
	});

	it("PATCH refuses panels that exceed page bounds", async () => {
		const res = await call(
			"PATCH",
			`/api/content/works/${workId}/panels`,
			{ pageNumber: 1, panels: [{ x: 0.9, y: 0, width: 0.2, height: 0.5 }] },
			cookie,
		);
		expect(res.status).toBe(400);
	});

	it("GET for a non-creator still reads panel geometry", async () => {
		const viewer = await createAccount(`panels_view_${RUN}`);
		const res = await call("GET", `/api/content/works/${workId}/panels`, undefined, viewer.cookie);
		expect(res.status).toBe(200);
		await db.delete(users).where(eq(users.id, viewer.userId as number));
	});
});
