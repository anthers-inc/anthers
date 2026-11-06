// SPDX-License-Identifier: Apache-2.0
/**
 * The Music Player lens's scope, as a Settings card (Parker, 2026-11-06).
 *
 * ⭐ **The control used to ride the lens's sidebar row** and now lives with the rest of the
 * browsing preferences, because it is a preference rather than a part of the lens's own
 * furniture. The lens reads the same `localStorage` answer through `lib/lens-preferences`,
 * so this card and the view it scopes cannot disagree.
 */

import { useState } from "react";
import { readIncludeSpoken, writeIncludeSpoken } from "../../lib/lens-preferences";

export default function MusicPlayerSection() {
	const [includeSpoken, setIncludeSpoken] = useState(readIncludeSpoken);

	const choose = (on: boolean) => {
		writeIncludeSpoken(on);
		setIncludeSpoken(on);
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Music Player</h3>
				<p className="text-sm text-base-content/60">
					What the Music Player lens draws on. This is remembered in this browser.
				</p>

				<div className="form-control mt-2">
					<label className="label whitespace-normal cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={includeSpoken}
							onChange={(e) => choose(e.target.checked)}
						/>
						<div>
							<span className="label-text font-medium">Include spoken word</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Episodes and other spoken-word audio join your albums and tracks in the lens.
								Turning this off leaves the Music Player to music alone.
							</p>
						</div>
					</label>
				</div>
			</div>
		</div>
	);
}
