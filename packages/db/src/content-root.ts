// SPDX-License-Identifier: Apache-2.0
/**
 * Where local storage keeps uploaded files, for the API and for the fixture scripts that write
 * files beside the rows they seed.
 *
 * Every session hands its own directory in as `LOCAL_CONTENT_DIR` and removes it when the session
 * ends, so an upload is as disposable as the database row that points at it (`scripts/session.ts`).
 *
 * ⚠️ **The fallback is the `dev` session's directory**, not a folder in the checkout. A fixture
 * script run from a second terminal — `make gauntlet-reset` beside a running `make dev` — has no
 * session environment of its own, and its files have to land where that dev server serves from.
 * Production never reaches this, because its app spec sets `STORAGE_BACKEND=s3`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** The `dev` session's upload directory; `scripts/session.ts` creates the same path. */
export const DEV_SESSION_CONTENT_DIR = join(tmpdir(), "anthers-sessions", "dev", "content");

export function localContentRoot(env: Record<string, string | undefined> = process.env): string {
	return env.LOCAL_CONTENT_DIR || DEV_SESSION_CONTENT_DIR;
}
