// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Image-upload helpers for the post form. Display images (thumbnails, image-element
 * images) go through the direct multipart endpoint, which returns both a storage
 * `key` (persisted on the post) and a `url` (used only for in-form preview).
 */

import { apiBaseUrl, apiFetch } from "../../lib/rpc";

/** mediaType values the direct endpoint accepts for display images. */
export type ImageMediaType = "image" | "thumbnail" | "cover";

/** Upload a display image via the direct endpoint. Returns the storage key + preview URL. */
export async function uploadImageFile(
	file: File,
	mediaType: ImageMediaType = "image",
): Promise<{ key: string; url: string }> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("mediaType", mediaType);
	const res = await apiFetch("/api/content/media-upload/direct", {
		method: "POST",
		body: formData,
	});
	if (!res.ok) throw new Error("Image upload failed");
	return (await res.json()) as { key: string; url: string };
}

/**
 * Best-effort preview URL for a stored image key loaded on edit. If the value is
 * already a URL (legacy rows stored full URLs), use it as-is; otherwise resolve it
 * through the local static route the dev server serves.
 */
export function keyToPreview(key: string): string {
	if (!key) return "";
	if (/^(https?:)?\/\//.test(key) || key.startsWith("/")) return key;
	return `${apiBaseUrl()}/content/${key}`;
}
