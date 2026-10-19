// SPDX-License-Identifier: Apache-2.0
/**
 * The preview parameters a page hands the API.
 *
 * 🚨 **The state lives in the URL, not in a component**, and that is deliberate: a
 * preview survives a refresh, can be linked to, and — the reason that matters — is
 * *visible*. A hidden mode that quietly changes what a creator sees is how somebody
 * ends up debugging a gate that was never broken. The server re-resolves with a
 * substituted context through the same `resolveAccessSync` everything else uses,
 * because a preview that reimplemented gate logic would drift and start lying in the
 * one situation it exists to clarify.
 */

import { useSearchParams } from "@anthers/web-shared/router";
import { useMemo } from "react";

/**
 * Read the preview out of the URL. Exported so pages can pass it to the API without
 * each one re-deriving the parameter names.
 *
 * Memoized on the VALUES, so the object is stable while they are. Returning a fresh
 * literal each render would churn the identity of every `useCallback` that closes over
 * it, and a data-fetching effect downstream would re-run on every render — which is the
 * kind of thing that is invisible until it is a loop.
 */
export function usePreviewQuery(): Record<string, string> {
	const [params] = useSearchParams();
	const as = params.get("previewAs");
	const owned = params.get("previewOwned");
	return useMemo(() => {
		if (!as) return {};
		return { previewAs: as, ...(owned === "1" ? { previewOwned: "1" } : {}) };
	}, [as, owned]);
}
