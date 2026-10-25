// SPDX-License-Identifier: Apache-2.0
/**
 * The version history a reader sees on a Work's page.
 *
 * ⭐ **Names and dates of versions added after release, and nothing else.** The public read
 * filters on `uploadedAt >= releasedAt`, so the build the Work was released with is the
 * baseline rather than the first entry — it was uploaded while the Work was still being
 * made. Maintenance after release is what this list makes visible.
 *
 * The hook is keyed on `versionAddedAt` as well as the Work id: a creator or a refetch that
 * moves the current version's date re-reads the history, so a page open across a replacement
 * does not keep showing the list it loaded before.
 */

import { client } from "@anthers/web-shared/rpc";
import type { WorkVersionEntry } from "@anthers/web-shared/types";
import { useEffect, useState } from "react";

export function useWorkVersionHistory(
	workId: number | null | undefined,
	versionAddedAt?: string | null,
): WorkVersionEntry[] {
	const [versions, setVersions] = useState<WorkVersionEntry[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a replacement moves `versionAddedAt`, and that is how the history re-reads.
	useEffect(() => {
		if (workId == null) {
			setVersions([]);
			return;
		}
		let live = true;
		client.api.content.works[":id"].versions.history
			.$get({ param: { id: String(workId) } })
			.then(async (res) => {
				if (!live || !res.ok) return;
				const body = (await res.json()) as { versions: WorkVersionEntry[] };
				setVersions(body.versions);
			})
			.catch(() => {
				// A history that cannot be read is not a page that cannot be read; the
				// deliverable and the rest of the record stand without it.
			});
		return () => {
			live = false;
		};
	}, [workId, versionAddedAt]);
	return versions;
}
