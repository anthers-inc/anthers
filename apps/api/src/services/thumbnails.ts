// SPDX-License-Identifier: Apache-2.0
/**
 * A stored cover reference resolved to the URL a browser can render.
 *
 * Thumbnails render directly as `<img src>`, but older rows stored a bare storage key
 * instead of a URL. New uploads already store URLs, and a URL or a root-relative path is
 * returned untouched; anything else is a key and is signed through the storage service.
 *
 * Extracted from the content routes so a second reader — search — resolves covers the
 * same way. Two copies of this rule would drift silently, because both produce a string
 * that an `<img>` accepts whether or not it is the right one.
 */
import { storage } from "./storage/index.js";

export async function resolveThumbnailUrl(thumbnail: string | null): Promise<string | null> {
	if (thumbnail && !/^(https?:)?\/\//.test(thumbnail) && !thumbnail.startsWith("/")) {
		return storage.getUrl(thumbnail);
	}
	return thumbnail;
}
