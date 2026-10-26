// SPDX-License-Identifier: Apache-2.0
/**
 * Image-upload helpers for the post form. Display images (thumbnails, image-element
 * images, and the inline images inside a post body) go through the direct multipart
 * endpoint, which returns both a storage `key` (persisted on the post) and a `url`
 * (used only for in-form preview; an inline image inserts it).
 */

import type { ImageCrop, ImageFrameType } from "@anthers/shared/image-frame";
import { apiBaseUrl, apiFetch } from "../../lib/rpc";

/** mediaType values the direct endpoint accepts for display images. */
export type ImageMediaType =
	| "image"
	| "thumbnail"
	| "cover"
	| "inline-image"
	| "preview-image"
	| "avatar"
	| "header";

/** Upload a display image via the direct endpoint. Returns the storage key + preview URL. */
export async function uploadImageFile(
	file: File,
	mediaType: ImageMediaType = "image",
	signal?: AbortSignal,
): Promise<{ key: string; url: string }> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("mediaType", mediaType);
	const res = await apiFetch("/api/content/media-upload/direct", {
		method: "POST",
		body: formData,
		signal,
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(
			typeof data?.error === "string" && data.error
				? data.error
				: "The image didn't upload. Check your connection and try again.",
		);
	}
	return (await res.json()) as { key: string; url: string };
}

/**
 * Frame a stored source at its surface's display shape, server-side.
 *
 * ⭐ **The source stays whole; this returns a derivative of the window the creator chose.**
 * The caller saves the derivative in the display column and the source in the `*_source`
 * column, which is what lets a later reposition zoom back out. The crop arithmetic is shared
 * with the dialog (`@anthers/shared/image-frame`), so the four numbers mean the same thing on
 * both sides.
 */
export async function frameImageFile(
	source: string,
	mediaType: ImageFrameType,
	crop: ImageCrop,
	signal?: AbortSignal,
): Promise<{ key: string; url: string }> {
	const res = await apiFetch("/api/content/media-upload/frame", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source, mediaType, crop }),
		signal,
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(
			typeof data?.error === "string" && data.error
				? data.error
				: "That image couldn't be framed. Try it again.",
		);
	}
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
