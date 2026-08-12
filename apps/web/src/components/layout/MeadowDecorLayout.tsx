// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A nested layout route that wraps its pages in the shared <MeadowDecor> — the
// pollen surface + woven climbing side vines — so the secondary marketing pages
// (about, compare, the economics demos, resources) share the botanical framing of
// For Users / For Creators. `floor={false}`: on logged-out pages the grassy floor
// is drawn once by LoggedOutLayout, below the footer. For Users / For Creators
// render their own <MeadowDecor> (with their editorial content), so they stay OUT
// of this group to avoid double-wrapping.

import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { FONTS } from "@anthers/web-shared/fonts";
import { Outlet } from "react-router-dom";
import RouteSuspense from "./RouteSuspense";

export default function MeadowDecorLayout() {
	return (
		<MeadowDecor floor={false} style={{ fontFamily: FONTS.nunito }}>
			<RouteSuspense>
				<Outlet />
			</RouteSuspense>
		</MeadowDecor>
	);
}
