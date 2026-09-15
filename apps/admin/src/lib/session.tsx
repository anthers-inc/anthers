// SPDX-License-Identifier: Apache-2.0
/**
 * Who is signed in to the admin app, and how to sign in or out.
 *
 * 🚨 **Nothing here reads the site's auth.** The admin app is signed into with an admin account,
 * which is a separate identity from an Anthers account, through `/api/admin/auth/*`. It does not use
 * `@anthers/web-shared/auth`, whose provider talks to `/api/auth/me` and would report an Anthers
 * account that opens nothing here.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

export interface AdminAccount {
	id: number;
	email: string;
	displayName: string;
	isSuperAdmin: boolean;
}

interface SessionValue {
	account: AdminAccount | null;
	loading: boolean;
	/** Re-read the session, after signing in or when a request comes back 401. */
	refresh: () => Promise<void>;
	signOut: () => Promise<void>;
	/**
	 * An absolute link to a page on the main site.
	 *
	 * The site's origin comes from the API rather than from this app's own host name, because the two
	 * are configured separately and guessing one from the other breaks the first time either moves.
	 */
	siteLink: (path: string) => string;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
	const [account, setAccount] = useState<AdminAccount | null>(null);
	const [siteUrl, setSiteUrl] = useState("");
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const res = await apiFetch("/api/admin/auth/me");
			if (!res.ok) {
				setAccount(null);
				return;
			}
			const body = (await res.json()) as { account: AdminAccount; siteUrl: string };
			setAccount(body.account);
			setSiteUrl(body.siteUrl);
		} catch {
			setAccount(null);
		} finally {
			setLoading(false);
		}
	}, []);

	const signOut = useCallback(async () => {
		await apiFetch("/api/admin/auth/sign-out", { method: "POST" }).catch(() => {});
		setAccount(null);
	}, []);

	const siteLink = useCallback((path: string) => `${siteUrl}${path}`, [siteUrl]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<SessionContext.Provider value={{ account, loading, refresh, signOut, siteLink }}>
			{children}
		</SessionContext.Provider>
	);
}

export function useSession(): SessionValue {
	const value = useContext(SessionContext);
	if (!value) throw new Error("useSession needs a SessionProvider");
	return value;
}
