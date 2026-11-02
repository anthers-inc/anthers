// SPDX-License-Identifier: Apache-2.0
/**
 * What the direct upload door is allowed to store, and where.
 *
 * An image Work's source set is its gallery, so it is a deliverable rather than storefront
 * chrome. A framing source is the whole picture behind an avatar, banner or thumbnail, and
 * only the derivative is public. The door checks both before it writes: the key prefix
 * decides the bucket on R2, and a key that looks public is world-readable regardless of
 * what the row says.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import app from "../index";
import { isPublicKey } from "../services/storage/acl";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { artwork } from "./scan-fixtures";

purgeAccountsCreatedHere();

let creator: Awaited<ReturnType<typeof createAccount>>;

beforeAll(async () => {
	creator = await createAccount(`upload_acl_${crypto.randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
	await purgeAccountsCreatedHere();
});

function upload(form: FormData) {
	return app.fetch(
		new Request("http://localhost/api/content/media-upload/direct", {
			method: "POST",
			headers: { Origin: "http://localhost:3000", Cookie: creator.cookie },
			body: form,
		}),
	);
}

describe("the direct upload door's storage policy", () => {
	it("refuses an HTML document named as an avatar", async () => {
		const form = new FormData();
		form.append(
			"file",
			new File(["<script>alert(1)</script>"], "avatar.html", { type: "text/html" }),
		);
		form.append("mediaType", "avatar");
		const res = await upload(form);
		expect(res.status).toBe(415);
	});

	it("refuses a real image whose extension disagrees with its type", async () => {
		// A real PNG named `.html` would otherwise be decoded, re-encoded and stored at a
		// key a CDN serves as HTML. The extension check is what stops that; the decoder
		// cannot, because the bytes are a perfectly good image.
		const form = new FormData();
		const png = await (await artwork(6)).arrayBuffer();
		form.append("file", new File([png], "avatar.html", { type: "image/png" }));
		form.append("mediaType", "avatar");
		const res = await upload(form);
		expect(res.status).toBe(415);
	});

	it("stores an image Work's source under the private source-images prefix", async () => {
		const form = new FormData();
		form.append("file", await artwork(3, "page.png"));
		form.append("mediaType", "image");
		const res = await upload(form);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { key: string };
		expect(body.key).toMatch(new RegExp(`^creators/${creator.userId}/source-images/`));
		expect(body.key).toEndWith(".webp");
		expect(isPublicKey(body.key)).toBe(false);
	});

	it("stores a framing source privately and its display image publicly", async () => {
		const sourceForm = new FormData();
		sourceForm.append("file", await artwork(4, "source.png"));
		sourceForm.append("mediaType", "avatar");
		sourceForm.append("purpose", "source");
		const sourceRes = await upload(sourceForm);
		expect(sourceRes.status).toBe(201);
		const source = (await sourceRes.json()) as { key: string };
		expect(source.key).toMatch(new RegExp(`^creators/${creator.userId}/sources/avatars/`));
		expect(isPublicKey(source.key)).toBe(false);

		const displayForm = new FormData();
		displayForm.append("file", await artwork(5, "display.png"));
		displayForm.append("mediaType", "avatar");
		const displayRes = await upload(displayForm);
		expect(displayRes.status).toBe(201);
		const display = (await displayRes.json()) as { key: string };
		expect(display.key).toMatch(new RegExp(`^creators/${creator.userId}/avatars/`));
		expect(isPublicKey(display.key)).toBe(true);
	});
});
