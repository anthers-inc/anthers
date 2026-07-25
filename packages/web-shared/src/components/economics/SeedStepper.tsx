// SPDX-License-Identifier: AGPL-3.0-or-later
import { SEED_PRICE } from "@anthers/shared/constants";

/**
 * Whole-Seed stepper.
 *
 * A Seed is an indivisible **$3** unit, so this control moves in Seeds, never in dollars:
 * `value`/`min`/`max` are dollar amounts (what the API stores), but every step is
 * `SEED_PRICE`, the number shown is the Seed *count*, and `set` snaps any typed value to
 * the nearest whole Seed at or below it. The API enforces the same rule — it rejects an
 * amount that isn't a multiple of `SEED_PRICE` — so a fraction of a Seed can't be
 * expressed at either end.
 *
 * `min` is doing real work at both call sites: within a billing cycle a Seed allocation
 * can only ever increase (the API rejects a decrease), so callers pass the already-committed
 * amount as `min` and the ratchet becomes visible in the UI instead of arriving as an error.
 */

export function SeedStepper({
	value,
	min,
	max,
	onChange,
	disabled,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (v: number) => void;
	disabled: boolean;
}) {
	// Snap to whole Seeds inside [min, max]. `min`/`max` come from the caller's budget and
	// ratchet, so they are honoured exactly even when they aren't Seed-aligned themselves.
	const snap = (v: number) => Math.floor(v / SEED_PRICE) * SEED_PRICE;
	const set = (v: number) => onChange(Math.max(min, Math.min(max, snap(v))));
	const seeds = Math.round(value / SEED_PRICE);
	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost"
				onClick={() => set(value - SEED_PRICE)}
				disabled={disabled || value <= min}
				aria-label="Fewer seeds"
			>
				−
			</button>
			<div className="join">
				<input
					type="number"
					min={Math.ceil(min / SEED_PRICE)}
					max={Math.floor(max / SEED_PRICE)}
					step={1}
					value={seeds}
					onChange={(e) => set((Number(e.target.value) || 0) * SEED_PRICE)}
					disabled={disabled}
					aria-label="Seeds"
					className="join-item input input-xs input-bordered w-12 text-center"
				/>
				<span className="join-item btn btn-xs btn-disabled no-animation whitespace-nowrap">
					{seeds === 1 ? "Seed" : "Seeds"} · ${value}
				</span>
			</div>
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost"
				onClick={() => set(value + SEED_PRICE)}
				disabled={disabled || value >= max}
				aria-label="More seeds"
			>
				+
			</button>
		</div>
	);
}
