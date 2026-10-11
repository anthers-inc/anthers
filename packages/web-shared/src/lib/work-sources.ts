// SPDX-License-Identifier: Apache-2.0
/**
 * The client-side shape of a paged Work's source set — what `GET /works/:id/source-files`
 * answers. The file is small deliberately: it is the contract the Studio's set editor reads,
 * typed once here so the component and its tests agree on it rather than inferring twice.
 */

/** One file of a Work's source set, in the server's JSON spelling. */
export interface WorkSourceFile {
	id: number;
	position: number;
	/** Private storage key or URL, as the server stores it — never rendered; pages are. */
	file: string;
	filename: string;
	fileSize: number | null;
	mimeType: string;
	/** ISO string, as the server's timestamps serialize. */
	createdAt: string;
}
