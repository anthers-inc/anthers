// SPDX-License-Identifier: Apache-2.0
/**
 * Load one admin endpoint into a screen: its data, whether it is loading, what went wrong, and a
 * way to load it again after an action.
 *
 * A 401 re-reads the session rather than showing an error, because it means the session ended — a
 * deactivation, an address change or the 12-hour limit — and the right screen then is the sign-in.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "./session";

export function useAdminData<T>(path: string) {
	const { refresh } = useSession();
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch(path);
			if (res.status === 401) {
				await refresh();
				return;
			}
			if (!res.ok) {
				setError(await errorText(res));
				return;
			}
			setData((await res.json()) as T);
		} catch {
			setError("Couldn't reach the API.");
		} finally {
			setLoading(false);
		}
	}, [path, refresh]);

	useEffect(() => {
		void reload();
	}, [reload]);

	return { data, loading, error, reload };
}

/** POST a JSON body to an admin endpoint, answering with the parsed body or the error to show. */
export async function adminPost<T = unknown>(
	path: string,
	body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	try {
		const res = await apiFetch(path, {
			method: "POST",
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!res.ok) return { ok: false, error: await errorText(res) };
		return { ok: true, data: (await res.json()) as T };
	} catch {
		return { ok: false, error: "Couldn't reach the API." };
	}
}

async function errorText(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
	return typeof body?.error === "string" ? body.error : `The request failed (${res.status}).`;
}
