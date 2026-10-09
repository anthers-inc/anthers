// SPDX-License-Identifier: Apache-2.0
/**
 * The inline-image flow the editor's toolbar button uses.
 *
 * The bytes go to the direct multipart endpoint (`/api/content/media-upload/direct`)
 * with `mediaType: "inline-image"` — display chrome under the creator's own
 * `inline-images/` prefix, one of `storage/acl.ts`'s `PUBLIC_MEDIA_TYPES`, and the
 * subject a scan match on the object names (`scannedObjectKind`). The row the
 * `/api/content/inline-images` route exists to hold is then written from the URL the
 * upload returned. That two-step shape is the route's own contract (it takes JSON with
 * an image URL, never a file), which is why a toolbar that posts the raw FormData
 * straight at it uploads nothing and fails silently.
 */
import { apiFetch } from "../../lib/rpc";
import { uploadImageFile } from "../post/mediaUpload";

/** The direct endpoint's own ceiling for display images. */
export const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload one image file and register the row, returning the URL to insert. Throws a
 * creator-readable message — every failure this can hit is one a person can act on, so
 * the caller shows the text rather than logging it.
 */
export async function uploadInlineImage(file: File): Promise<string> {
	if (file.size > INLINE_IMAGE_MAX_BYTES) {
		throw new Error("That image is larger than 10 MB.");
	}
	const { url } = await uploadImageFile(file, "inline-image");
	const res = await apiFetch("/api/content/inline-images", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ image: url }),
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => null)) as { error?: string } | null;
		if (data?.error) throw new Error(data.error);
		throw new Error("The image didn't upload. Check your connection and try again.");
	}
	return url;
}
