// SPDX-License-Identifier: Apache-2.0
/**
 * The two documents a crawler asks for by name.
 *
 * Every route of the site answered with the application shell, so `/robots.txt` was read as a
 * page and `/sitemap.xml` as HTML. These are the routes that must answer with their own
 * content, and the homepage is asserted beside them so a rule added here cannot shadow the
 * shell it sits in front of.
 */

import { expect, test, WEB_ORIGIN } from "./fixtures";

test("robots.txt is a policy that names the sitemap", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/robots.txt`);
	expect(res.status()).toBe(200);
	expect(res.headers()["content-type"]).toContain("text/plain");
	const body = await res.text();

	expect(body).toContain("User-agent: *");
	expect(body).toContain("Allow: /");
	expect(body).toContain("Disallow: /studio");
	expect(body).toContain("Sitemap: https://anthers.org/sitemap.xml");
});

test("sitemap.xml lists the standing pages at their own addresses", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/sitemap.xml`);
	expect(res.status()).toBe(200);
	expect(res.headers()["content-type"]).toContain("application/xml");
	const body = await res.text();

	expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
	expect(body).toContain("<loc>https://anthers.org/</loc>");
	expect(body).toContain("<loc>https://anthers.org/for-creators</loc>");
	expect(body).toContain("<loc>https://anthers.org/privacy</loc>");
	// A door is not a page a crawler should open.
	expect(body).not.toContain("<loc>https://anthers.org/login</loc>");
});

test("the homepage still answers with the app, not a crawler document", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/`);
	expect(res.status()).toBe(200);
	expect(res.headers()["content-type"]).toContain("text/html");
	expect(await res.text()).toContain('<div id="root">');
});
