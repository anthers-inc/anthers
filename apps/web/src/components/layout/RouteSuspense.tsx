// SPDX-License-Identifier: AGPL-3.0-or-later
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { Suspense } from "react";

/**
 * The Suspense boundary a lazy route page falls into while its chunk downloads.
 *
 * 🚨 It belongs immediately around an `<Outlet />`, never around `<Routes>`. React
 * suspends at the *nearest* boundary and replaces everything under it with the fallback —
 * so a boundary above a layout tears the layout down, which for this app means the
 * botanical decor repaints on every navigation. Keeping the shell mounted across
 * navigations is the entire reason PublicShell exists; read its header before moving one
 * of these upward.
 *
 * Every page in App.tsx is `lazy`, so every `<Outlet />` needs one of these above it.
 */
export default function RouteSuspense({ children }: { children: React.ReactNode }) {
	return (
		<Suspense
			fallback={
				<div className="flex min-h-[60vh] items-center justify-center">
					<LoadingSpinner size="lg" />
				</div>
			}
		>
			{children}
		</Suspense>
	);
}
