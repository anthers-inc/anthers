// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared presentational primitives for the resource calculators. Kept small and
// DaisyUI-native so the three calculators read as one consistent set and follow
// the site's light/dark theme.

import { Link } from "@anthers/web-shared/router";
import { ChevronLeftIcon } from "@heroicons/react/24/outline";

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------

export function CalcPageHeader({
	eyebrow,
	title,
	lede,
}: {
	eyebrow: string;
	title: string;
	lede: React.ReactNode;
}) {
	return (
		<section className="pt-8 pb-6">
			<Link
				to="/resources"
				className="inline-flex items-center gap-1 text-sm text-base-content/50 hover:text-base-content mb-6"
			>
				<ChevronLeftIcon className="w-4 h-4" />
				All resources
			</Link>
			<p className="text-xs font-mono font-medium text-primary tracking-[0.2em] uppercase mb-3">
				{eyebrow}
			</p>
			<h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">{title}</h1>
			<p className="text-base-content/60 max-w-3xl leading-relaxed">{lede}</p>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export interface SegOption<T> {
	value: T;
	label: string;
}

export function SegControl<T extends string | number>({
	options,
	value,
	onChange,
	ariaLabel,
}: {
	options: SegOption<T>[];
	value: T;
	onChange: (value: T) => void;
	ariaLabel: string;
}) {
	return (
		// `overflow-x-auto` lets the segmented control scroll horizontally when
		// the option labels are too wide or too many for the parent width (e.g.
		// the 6-platform compare page on mobile). Without it the `flex-1`
		// buttons' `min-width: auto` (their longest label) overflows the
		// `w-full` fieldset and pushes the page wider than the viewport.
		<fieldset
			className="join w-full min-w-0 overflow-x-auto border-0 m-0 p-0"
			aria-label={ariaLabel}
		>
			{options.map((opt) => (
				<button
					type="button"
					key={String(opt.value)}
					aria-pressed={opt.value === value}
					onClick={() => onChange(opt.value)}
					className={`join-item btn btn-sm flex-1 font-mono ${
						opt.value === value ? "btn-primary" : "btn-ghost bg-base-200/60"
					}`}
				>
					{opt.label}
				</button>
			))}
		</fieldset>
	);
}

// ---------------------------------------------------------------------------
// Labelled numeric field (with optional $ prefix / unit suffix)
// ---------------------------------------------------------------------------

export function NumberField({
	label,
	hint,
	value,
	onChange,
	min = 0,
	step = 1,
	prefix,
	suffix,
}: {
	label: string;
	hint?: string;
	value: number;
	onChange: (value: number) => void;
	min?: number;
	step?: number;
	prefix?: string;
	suffix?: string;
}) {
	return (
		<label className="block">
			<span className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
				<span>{label}</span>
				{hint && <span className="text-xs font-mono text-base-content/40">{hint}</span>}
			</span>
			<div className="flex items-center bg-base-200/60 border border-base-content/10 rounded-lg overflow-hidden focus-within:border-primary transition-colors">
				{prefix && (
					<span className="pl-3 pr-2 py-2 text-base-content/40 font-mono text-sm border-r border-base-content/10">
						{prefix}
					</span>
				)}
				<input
					type="number"
					inputMode="decimal"
					min={min}
					step={step}
					value={value}
					onChange={(e) => {
						const v = Number.parseFloat(e.target.value);
						onChange(Number.isFinite(v) && v >= min ? v : min);
					}}
					className="flex-1 min-w-0 bg-transparent px-3 py-2 font-mono text-base focus:outline-none tabular-nums"
				/>
				{suffix && (
					<span className="px-3 py-2 text-base-content/40 font-mono text-xs whitespace-nowrap border-l border-base-content/10">
						{suffix}
					</span>
				)}
			</div>
		</label>
	);
}

// ---------------------------------------------------------------------------
// Stat / readout card
// ---------------------------------------------------------------------------

export type StatTone = "default" | "money" | "time";

export function StatCard({
	label,
	value,
	unit,
	sub,
	tone = "default",
}: {
	label: string;
	value: React.ReactNode;
	unit?: string;
	sub?: React.ReactNode;
	tone?: StatTone;
}) {
	const bg =
		tone === "money"
			? "bg-warning/10 border-transparent"
			: tone === "time"
				? "bg-success/10 border-transparent"
				: "bg-base-200 border-base-300";
	const valueColor =
		tone === "money" ? "text-warning" : tone === "time" ? "text-success" : "text-base-content";
	return (
		<div className={`rounded-xl border p-4 ${bg}`}>
			<p className="text-xs uppercase tracking-wide text-base-content/50">{label}</p>
			<p className={`mt-1 font-mono text-2xl font-bold tabular-nums leading-none ${valueColor}`}>
				{value}
				{unit && <span className="ml-1 text-sm font-medium text-base-content/50">{unit}</span>}
			</p>
			{sub && <p className="mt-1.5 text-xs text-base-content/50">{sub}</p>}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Notes / assumptions block
// ---------------------------------------------------------------------------

export function CalcNotes({ children }: { children: React.ReactNode }) {
	return (
		<div className="mt-8 border-t border-base-300 pt-5 text-xs leading-relaxed text-base-content/50 space-y-2">
			{children}
		</div>
	);
}
