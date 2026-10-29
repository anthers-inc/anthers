// SPDX-License-Identifier: Apache-2.0
//
// Digital Asset Links, which is how Android decides that an `anthers.org` link belongs to
// the Anthers app rather than to a browser.
//
// 🚨 **A malformed file has no symptom anywhere except on a device.** Android silently
// leaves the app unverified, links open in the browser, and nothing logs, alerts or fails a
// build — so a typo in the package name or one wrong digit of the fingerprint would be
// discovered only by somebody holding a phone. That is the whole reason this test exists;
// it can check the shape here, and the fingerprint against the signing key is a fact no
// repository holds (the key lives in Bitwarden Secrets).
//
// The file is served from `apps/web/public/.well-known/` through `build.ts`'s copy into
// `dist/`, and `serve.ts` resolves it as an ordinary dist file ahead of the SPA fallback,
// which matters: the fallback would otherwise answer with `index.html` and a 200, which is
// the cheerful-wrong-answer shape this codebase has been bitten by before.
//
// Regenerating the fingerprint: it is the release key's certificate SHA-256, printed by
// `apksigner verify --print-certs` over a published artifact. `Publish the first Android
// release` in the vault's task board recorded the current value with its reasoning.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const FILE = join(import.meta.dir, "public", ".well-known", "assetlinks.json");

/** The app the file vouches for. `tauri.conf.json`'s identifier in the mobile repository. */
const PACKAGE = "org.anthers.mobile";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

type Statement = {
	relation?: unknown;
	target?: {
		namespace?: unknown;
		package_name?: unknown;
		sha256_cert_fingerprints?: unknown;
	};
};

const statements = await Bun.file(FILE)
	.json()
	.catch(() => null) as Statement[] | null;

describe("the Android app-links association file", () => {
	it("is a list of statements, which is the shape Android reads", () => {
		expect(Array.isArray(statements)).toBe(true);
		expect(statements?.length).toBeGreaterThan(0);
	});

	it("grants link handling to this package and nothing else", () => {
		for (const statement of statements ?? []) {
			expect(statement.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
			expect(statement.target?.namespace).toBe("android_app");
			expect(statement.target?.package_name).toBe(PACKAGE);
		}
	});

	it("names real SHA-256 fingerprints", () => {
		// Uppercase, colon-separated, 32 bytes: the format Android compares against byte for
		// byte. A lowercase or unpunctuated digest is a silent mismatch.
		for (const statement of statements ?? []) {
			const fingerprints = statement.target?.sha256_cert_fingerprints;
			expect(Array.isArray(fingerprints)).toBe(true);
			for (const fingerprint of fingerprints as unknown[]) {
				expect(typeof fingerprint).toBe("string");
				expect(fingerprint).toMatch(FINGERPRINT);
			}
		}
	});
});
