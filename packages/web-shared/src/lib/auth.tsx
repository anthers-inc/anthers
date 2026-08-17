// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { client } from "./rpc";
import { applyTheme, storeTheme, type Theme } from "./theme";

/**
 * User shape returned from /api/auth/me.
 * Matches the serializeUser() output in apps/api/src/routes/auth.ts.
 */
export interface User {
	id: number;
	/**
	 * Null until onboarding claims one — see `hasOnboarded` below.
	 *
	 * 🚨 This is the **signed-in** user, which is the one shape where a null handle is a
	 * live state rather than an impossibility: the signup ceremony creates and signs in
	 * the account the moment its emailed code is verified, and asks for a name after. The
	 * public shapes (`PublicUser`, `Creator` in `lib/types.ts`) stay `string`, because the
	 * API refuses to serialize an unclaimed account into either — so a null reaches the
	 * browser for *yourself* and never for anybody else.
	 *
	 * Anything building a profile link out of this has to route to onboarding instead.
	 */
	username: string | null;
	email: string;
	displayName: string | null;
	bio: string | null;
	isCreator: boolean | null;
	isAdmin: boolean | null;
	avatar: string | null;
	headerImage: string | null;
	websiteUrl: string | null;
	location: string | null;
	emailVerified: boolean | null;
	themePreference: Theme | null;
	atprotoDid: string | null;
	atprotoHandle: string | null;
	createdAt: string;
}

interface AuthContextValue {
	user: User | null;
	isLoading: boolean;
	isAuthenticated: boolean;
	signIn: (login: string, password: string) => Promise<void>;
	/**
	 * 🚨 **There is no `signUp` here, and putting one back would rebuild a second signup
	 * door** (removed 2026-08-17 with the Create Account card that was its only caller).
	 *
	 * Signing up is a *ceremony*, not a call: `POST /auth/signup/start` mails a code,
	 * `/signup/verify` creates the account and issues the session, and `/welcome` claims
	 * the handle and takes terms acceptance. It lives in `pages/SubscribePage.tsx` +
	 * `SignupCeremonyModal` because the ordering matters — see the note on `leave()`
	 * there about refreshing the auth context last.
	 *
	 * ⚠️ `POST /auth/sign-up` (username + email + password + acceptTerms) is still a live,
	 * tested API route with **no caller in the app**. It is what `signUp` wrapped. Leave
	 * it be unless you are deliberately retiring the password-signup path server-side too;
	 * what must not come back is a *second* place in the UI that mints accounts, since
	 * two doors have to keep agreeing about terms, onboarding and where a new account
	 * lands, and the last pair had already drifted.
	 */
	signOut: () => Promise<void>;
	signInWithBluesky: (handle: string) => Promise<void>;
	linkBluesky: (handle: string) => Promise<void>;
	unlinkBluesky: () => Promise<void>;
	refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Pull a human-readable message out of an error response body. Business errors
 * return `{ error: "message" }` (a string). Validation failures come back from
 * @hono/zod-validator as `{ error: <ZodError> }` — an object that stringifies to
 * "[object Object]" — so fall back to the first issue's message (e.g. "Invalid
 * email"), then to a generic fallback if the body isn't shaped as expected.
 */
async function errorText(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as {
			error?: string | { issues?: { message?: unknown }[] };
		};
		const err = body?.error;
		if (typeof err === "string") return err;
		const issue = typeof err === "object" ? err?.issues?.[0]?.message : undefined;
		if (typeof issue === "string") return issue;
	} catch {
		// Non-JSON / empty body — use the fallback.
	}
	return fallback;
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	const refreshUser = useCallback(async () => {
		try {
			const res = await client.api.auth.me.$get();
			if (res.ok) {
				const data = await res.json();
				setUser(data.user as User | null);
			} else {
				setUser(null);
			}
		} catch {
			setUser(null);
		}
	}, []);

	useEffect(() => {
		refreshUser().finally(() => setIsLoading(false));
	}, [refreshUser]);

	// The account's saved theme (once we know who's signed in) overrides the device
	// choice the pre-paint script already applied. Mirror it into localStorage too, so
	// this device's next pre-paint matches and there's no flash on the following load.
	useEffect(() => {
		const pref = user?.themePreference;
		if (pref) {
			applyTheme(pref);
			storeTheme(pref);
		}
	}, [user?.themePreference]);

	const signIn = useCallback(async (login: string, password: string) => {
		const res = await client.api.auth["sign-in"].$post({
			json: { login, password },
		});
		if (!res.ok) {
			throw new Error(await errorText(res, "Sign in failed."));
		}
		const data = await res.json();
		setUser(data.user as User);
	}, []);

	const signOut = useCallback(async () => {
		await client.api.auth["sign-out"].$post();
		setUser(null);
	}, []);

	const signInWithBluesky = useCallback(async (handle: string) => {
		const res = await client.api.atproto.auth.$post({
			json: { handle, intent: "login" },
		});
		if (!res.ok) {
			throw new Error(await errorText(res, "Bluesky auth failed."));
		}
		const data = await res.json();
		// Redirect to Bluesky authorization page
		window.location.href = (data as any).authorization_url;
	}, []);

	const linkBluesky = useCallback(async (handle: string) => {
		const res = await client.api.atproto.auth.$post({
			json: { handle, intent: "link" },
		});
		if (!res.ok) {
			throw new Error(await errorText(res, "Bluesky link failed."));
		}
		const data = await res.json();
		window.location.href = (data as any).authorization_url;
	}, []);

	const unlinkBluesky = useCallback(async () => {
		const res = await client.api.atproto.unlink.$post();
		if (!res.ok) {
			throw new Error(await errorText(res, "Unlink failed."));
		}
		await refreshUser();
	}, [refreshUser]);

	return (
		<AuthContext.Provider
			value={{
				user,
				isLoading,
				isAuthenticated: user !== null,
				signIn,
				signOut,
				signInWithBluesky,
				linkBluesky,
				unlinkBluesky,
				refreshUser,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextValue {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return context;
}
