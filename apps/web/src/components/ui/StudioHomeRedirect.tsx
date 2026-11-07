// SPDX-License-Identifier: Apache-2.0
import { Navigate } from "react-router-dom";

/**
 * `/studio` itself, the Studio's root.
 *
 * ⭐ **The root lands on Works** (Parker, 2026-11-06). It used to be the Dashboard page, then a
 * redirect to that page's tab on the creator's own profile; the tab is gone, so the Studio's
 * front door is the creator's catalog. The widgets the Dashboard carried already have their
 * own homes — analytics under Analytics, payments under Payments, orders under Orders.
 *
 * It stays a route rather than being deleted because the address is a destination in the
 * world: `RootRedirect` sends a desktop app whose home is the Studio here, the creator side of
 * the mode switch goes through it, and `/dashboard/* → /studio/*` lands on it. ⚠️ **The gate has
 * already run** — this renders inside `StudioAuthGate`, so the Works page is only reached by a
 * signed-in creator.
 */
export default function StudioHomeRedirect() {
	return <Navigate to="/studio/works" replace />;
}
