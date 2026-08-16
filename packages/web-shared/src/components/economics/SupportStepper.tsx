// SPDX-License-Identifier: AGPL-3.0-or-later
import { PUBLIC_ACCESS_PRICE, supportAmount } from "@anthers/shared/constants";

/**
 * Monthly-support amount input, in dollars.
 *
 * 🚨 **This control WAS the granularity floor** (`SeedStepper`, until 2026-08-16). It
 * stepped by `SEED_PRICE`, displayed a Seed *count* rather than an amount, and snapped any
 * typed value down to the nearest whole $3 — so a creator could not express $5, $10 or $25,
 * and the jump from the first rung to the second was 100%. The API enforced the same rule
 * from the other side, which meant the floor was real rather than merely suggested.
 *
 * Both halves are gone. **Any amount is expressible**, cents included; the arrows are a
 * convenience with a $1 step, not a constraint. The one bound that survives is the
 * caller's `min`/`max`, and there is a minimum on the whole monthly *invoice* rather than
 * on any single destination — see `MIN_INVOICE_TOTAL` in the subscriptions route for why
 * the fixed card fee can only ever justify that shape of floor.
 *
 * `min` is doing real work at both call sites: within a billing cycle an allocation can
 * only ever increase (the API rejects a decrease), so callers pass the already-committed
 * amount as `min` and the ratchet becomes visible in the UI instead of arriving as an error.
 */

/** The arrows' step. A convenience for the common case, never a constraint on typing. */
const STEP = 1;

export function SupportStepper({
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
	// Clamp to the caller's bounds and round to cents — the grain Stripe charges in, and
	// the grain `amountMeets` compares in. Anything finer cannot be paid or matched.
	const set = (v: number) =>
		onChange(supportAmount(Math.max(min, Math.min(max, Number.isFinite(v) ? v : min))));
	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost"
				onClick={() => set(value - STEP)}
				disabled={disabled || value <= min}
				aria-label="Give less"
			>
				−
			</button>
			<div className="join">
				<span className="join-item btn btn-xs btn-disabled no-animation">$</span>
				<input
					type="number"
					min={min}
					max={max}
					step="0.01"
					value={value}
					onChange={(e) => set(Number(e.target.value))}
					disabled={disabled}
					aria-label="Monthly amount"
					className="join-item input input-xs input-bordered w-20 text-center"
				/>
				<span className="join-item btn btn-xs btn-disabled no-animation whitespace-nowrap">
					/month
				</span>
			</div>
			<button
				type="button"
				className="btn btn-xs btn-circle btn-ghost"
				onClick={() => set(value + STEP)}
				disabled={disabled || value >= max}
				aria-label="Give more"
			>
				+
			</button>
		</div>
	);
}

/** What unlimited Public Access costs — re-exported so a caller need not import twice. */
export { PUBLIC_ACCESS_PRICE };
