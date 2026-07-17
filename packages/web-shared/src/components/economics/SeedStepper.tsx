// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whole-dollar Seed stepper.
 *
 * Seeds are $1 units, so the control is deliberately integer-only — `set` floors and
 * clamps, which keeps a typed value inside [min, max] as well as the buttons do.
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
	const set = (v: number) => onChange(Math.max(min, Math.min(max, Math.floor(v))));
	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost"
				onClick={() => set(value - 1)}
				disabled={disabled || value <= min}
				aria-label="Fewer seeds"
			>
				−
			</button>
			<div className="join">
				<span className="join-item btn btn-xs btn-disabled no-animation">$</span>
				<input
					type="number"
					min={min}
					max={max}
					step={1}
					value={value}
					onChange={(e) => set(Number(e.target.value) || 0)}
					disabled={disabled}
					className="join-item input input-xs input-bordered w-14 text-center"
				/>
			</div>
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost"
				onClick={() => set(value + 1)}
				disabled={disabled || value >= max}
				aria-label="More seeds"
			>
				+
			</button>
		</div>
	);
}
