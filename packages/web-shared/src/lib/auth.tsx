// SPDX-License-Identifier: Apache-2.0
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { client } from "./rpc";
import { applyTheme, storeTheme, type Theme } from "./theme";

/**
 * The tabs of the signed-in site, in the sidebar's fixed order (Library, Discovery).
 * The nav ids are the vocabulary `PATCH /api/accounts/me` accepts, so the server's enum
 * and this union name the same two things.
 *
 * ⚠️ **There were three until 2026-10-24**, when Network retired into Discovery as a
 * recipe preset. The union shrank with the nav rather than keeping a retired id: an
 * account whose stored starting tab was `network` now reads as never-answered and lands
 * on the default, which is the merged tab.
 */
export type UserTabId = "library" | "discovery";

/**
 * User shape returned from /api/auth/me.
 * Matches the serializeUser() output in apps/api/src/routes/auth.ts.
 */
export interface User {
	id: number;
	/** The account's ATProto handle — every account has one; there is no separate username. */
	handle: string;
	email: string;
	displayName: string | null;
	bio: string | null;
	creatorMode: boolean | null;
	/**
	 * Whether this account is a creator — completed creator setup, answered on the server by
	 * `services/creator-standing` and never written by a client.
	 *
	 * ⚠️ **Not the same claim as `creatorMode`.** Mode says the person turned the Studio on;
	 * this says they finished setting it up.
	 */
	isCreator: boolean;
	/** Whether this deployment can offer the Discord link at all. */
	isDiscordAvailable: boolean;
	/** Whether this account has linked its Discord identity. */
	isDiscordLinked: boolean;
	avatar: string | null;
	bannerImage: string | null;
	/** The full uploads the images were framed from; the owner's own reposition starts here. */
	avatarSource?: string | null;
	bannerImageSource?: string | null;
	/** The windows they were last framed at, so a reposition reopens where it was left. */
	avatarCrop?: import("@anthers/shared/image-frame").ImageCrop | null;
	bannerImageCrop?: import("@anthers/shared/image-frame").ImageCrop | null;
	websiteUrl: string | null;
	location: string | null;
	emailVerified: boolean | null;
	themePreference: Theme | null;
	/**
	 * The tab a signed-in session opens on. Null = never answered, and the reader
	 * treats that as **Discovery** — the column never bakes the default in, so a later
	 * default change would not have to rewrite rows.
	 */
	homeDefaultTab: UserTabId | null;
	/**
	 * The Discovery recipe the account last chose, as the three raw values the column
	 * stores. The page parses them through `@anthers/shared/discovery` rather than
	 * trusting them: a value written by a build that knew a candidate this one does not
	 * degrades to the default instead of rendering a recipe nothing can run.
	 * Null = never answered, read as the **My Network** preset.
	 */
	homeRecipe: { window: string; candidates: string; mix: string } | null;
	/**
	 * The Discovery recipes this account saved, in chip order. Each row is parsed through
	 * `@anthers/shared/discovery`'s `savedRecipesFrom`, which drops a row this build
	 * cannot render rather than showing a half-chip. Null and `[]` both mean none saved.
	 */
	savedRecipes: Array<{
		id: string;
		label: string;
		color: string;
		recipe: { window: string; candidates: string; mix: string };
	}> | null;
	/**
	 * Whether audio playback rides the persistent footer bar rather than a Work page's
	 * own player. Null = never answered, and the reader treats that as **on** — the
	 * column never bakes the default in, so a later default change would not have to
	 * rewrite rows.
	 */
	persistentMiniplayer: boolean | null;
	/**
	 * The account's rebindable shortcuts, `{ search, filter, fullscreen, theater }`, as
	 * portable chord strings.
	 * Null = never set, so the defaults in `@anthers/shared/keybindings` stand.
	 */
	keyboardShortcuts: Record<string, string> | null;
	/** Every account holds exactly one ATProto identity, so it is always present. */
	atprotoDid: string;
	/**
	 * The server holding that identity: Anthers' own node for an identity it issued, or the
	 * server the person brought it from. Public, since it is in the DID document.
	 */
	atprotoPdsUrl: string;
	/** When the terms (and the 13+ assertion) were accepted; null until `/welcome` finishes onboarding. */
	termsAcceptedAt: string | null;
	createdAt: string;
}

interface AuthContextValue {
	user: User | null;
	isLoading: boolean;
	isAuthenticated: boolean;
	/**
	 * 🚨 **There is no `signIn` and no `signUp` on this context, and neither may come
	 * back**, because both imply a *form*: a credential typed into a page. Sign-in is the
	 * emailed code — `/login` drives `POST /auth/signin/*` itself — and signing up is the
	 * ceremony below.
	 *
	 * 🚨 **There is no `signUp` here, and putting one back would rebuild a second signup
	 * door** (removed 2026-08-17 with the Create Account card that was its only caller).
	 *
	 * Signing up is a *ceremony*, not a call: `POST /auth/signup/begin` writes a pending signup
	 * holding the chosen identity, `/finish` proves the address with an emailed code,
	 * `/signup/verify` (or `/signup/complete`) creates the account with its identity and issues
	 * the session, and `/welcome` closes out the first run. It lives in
	 * `pages/SignupPage.tsx` and `pages/FinishSignupPage.tsx` because the ordering matters.
	 *
	 * ⚠️ **There is no password sign-up route on the server either — and no password sign-in
	 * route since 2026-09-20.** What must not come back is a second place that mints accounts,
	 * in the UI or the API, since two doors have to keep agreeing about terms, onboarding and
	 * where a new account lands, and the last pair had already drifted. Tests make accounts
	 * with `apps/api/src/__tests__/account-fixture.ts`.
	 */
	signOut: () => Promise<void>;
	/**
	 * Sign in with an ATProto identity. Leaves the site: the promise only rejects, because
	 * resolving means the browser is already on its way to an authorization server.
	 *
	 * 🚨 **This signs in; it cannot sign anyone up.** A handle nobody has linked comes back
	 * from the callback as `signup_disabled` — signing up is `signUpWithBluesky`, which is a
	 * different intent asking for a different scope.
	 *
	 * `next` is where to land afterwards. It rides in the OAuth flow's server-side state and
	 * is sanitized at both ends; see `@anthers/shared/next-path`.
	 */
	signInWithBluesky: (handle: string, next?: string | null) => Promise<void>;
	/**
	 * Sign up with an ATProto identity.
	 *
	 * ⚠️ **This is not the second signup door the `signUp` note above forbids, and the
	 * difference is worth being precise about, because it looks like one.** It mints
	 * nothing: it starts an OAuth round trip whose callback parks the proved identity on the
	 * pending signup, and the account — if there is to be one — is created server-side by
	 * `/auth/signup/verify` or `/signup/complete`.
	 * It also lives on **`/signup`**, the one signup page, rather than adding a second
	 * place in the UI that people can join from. What the deleted `signUp` did that this
	 * does not is create an account straight from a form, with its own idea of onboarding.
	 *
	 * 🚨 The scope it asks for is wider than sign-in's — `atproto transition:email` — because
	 * Anthers never creates an account it cannot mail. That is exactly why signing up is a
	 * separate intent rather than a flag on sign-in: nobody signing in should be asked to
	 * hand over read access to their email address.
	 */
	signUpWithBluesky: (handle: string, next?: string | null) => Promise<void>;
	/** `next` is where to land afterwards; without it the round trip ends on Studio settings. */
	grantPublishing: (next?: string) => Promise<void>;
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
// ⚠️ **Takes what it uses rather than a `Response`.** The RPC client hands back a
// `ClientResponse`, whose union widens every time a route gains another status code — so a
// parameter typed as the whole of `Response` breaks call sites here whenever an unrelated
// endpoint grows a branch. This function reads a JSON body and nothing else.
async function errorText(res: { json: () => Promise<unknown> }, fallback: string): Promise<string> {
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

	const signOut = useCallback(async () => {
		await client.api.auth["sign-out"].$post();
		setUser(null);
	}, []);

	/**
	 * Start an ATProto OAuth round trip and hand the browser over to the authorization
	 * server. Shared by all three intents, because what differs is the scope asked for and
	 * what the callback does on the way back — neither of which is this function's business.
	 */
	const beginAtprotoAuth = useCallback(
		async (
			json: { handle?: string; intent: "login" | "signup" | "publish"; next?: string },
			fallback: string,
		) => {
			const res = await client.api.atproto.auth.$post({ json });
			if (!res.ok) {
				throw new Error(await errorText(res, fallback));
			}
			const { authorization_url } = (await res.json()) as { authorization_url: string };
			window.location.href = authorization_url;
		},
		[],
	);

	const signInWithBluesky = useCallback(
		async (handle: string, next?: string | null) => {
			await beginAtprotoAuth(
				{ handle, intent: "login", ...(next ? { next } : {}) },
				"Couldn't start Bluesky sign-in.",
			);
		},
		[beginAtprotoAuth],
	);

	const signUpWithBluesky = useCallback(
		async (handle: string, next?: string | null) => {
			await beginAtprotoAuth(
				{ handle, intent: "signup", ...(next ? { next } : {}) },
				"Couldn't start Bluesky signup.",
			);
		},
		[beginAtprotoAuth],
	);

	/**
	 * Ask for permission to keep this creator's Work listings in their own repository.
	 *
	 * ⚠️ **No handle, deliberately.** The API authorizes against the DID already on the account,
	 * so there is nothing for the browser to supply and nothing an attacker could substitute.
	 */
	const grantPublishing = useCallback(
		async (next?: string) => {
			await beginAtprotoAuth(
				{ intent: "publish", ...(next ? { next } : {}) },
				"Couldn't start the Bluesky permission.",
			);
		},
		[beginAtprotoAuth],
	);

	return (
		<AuthContext.Provider
			value={{
				user,
				isLoading,
				isAuthenticated: user !== null,
				signOut,
				signInWithBluesky,
				signUpWithBluesky,
				grantPublishing,
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
