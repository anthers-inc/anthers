// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noArrayIndexKey: a variant and its values are positional rows with no ids; every control addresses the position.
/**
 * The fields a physical good edits on its own storefront, and the policy facts a buyer
 * reads under the price.
 *
 * ⭐ **The buyer view is the editor** (Parker, 2026-10-29): variants carry their own pencils
 * in the panel, and the parcel's policy sits below the price box rather than in the Manage
 * tab. A buyer who is not the creator sees the same facts without a pencil, so the two
 * surfaces cannot drift.
 *
 * The variant builder is one option at a time here; the caller passes a one-item array from
 * a row's edit state. Removing a variant is the row's own trash button, not this editor's,
 * because an empty editor has nothing to return to.
 */
import { PHYSICAL_TAX_CATEGORIES, type PhysicalTaxCategory } from "@anthers/shared/tax-codes";
import { InlineField } from "./Editing";
import type { Listing, ListingOption, ListingValue } from "./physical-listing";

/** The range the server clamps into; the picker offers the same numbers. */
const HANDLING_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** How many variants a good may offer — the service's own ceiling. */
export const MAX_OPTIONS = 3;

/**
 * The variant builder: a name with its values and stock counts.
 *
 * A blank count means unlimited, which is the ordinary case for a creator making things
 * to order — so blank is where the field starts rather than a count nobody meant.
 */
export function PhysicalVariantEditor({
	options,
	onChange,
	showAddVariant = true,
	showRemove = true,
}: {
	options: ListingOption[];
	onChange: (next: ListingOption[]) => void;
	/** The inline row editor edits one option and never adds another. */
	showAddVariant?: boolean;
	/** Removal belongs to the row's own trash button, outside this editor. */
	showRemove?: boolean;
}) {
	const patch = (index: number, next: ListingOption) =>
		onChange(options.map((option, i) => (i === index ? next : option)));

	const patchValue = (index: number, valueIndex: number, next: ListingValue) =>
		patch(index, {
			...options[index],
			values: options[index].values.map((value, i) => (i === valueIndex ? next : value)),
		});

	return (
		<div className="flex flex-col gap-4">
			{options.map((option, index) => (
				<div key={index} className="rounded-box border border-base-300 p-4">
					<div className="flex flex-wrap items-end gap-2">
						<div className="flex min-w-48 flex-1 flex-col gap-1">
							<label
								className="text-xs text-base-content/60"
								htmlFor={`physical-variant-${index}-name`}
							>
								Variant
							</label>
							<input
								id={`physical-variant-${index}-name`}
								aria-label={`Variant ${index + 1} name`}
								className="input input-bordered input-sm w-full max-w-sm"
								placeholder="Size, color, scent…"
								value={option.name}
								onChange={(e) => patch(index, { ...option, name: e.target.value })}
							/>
						</div>
						{showRemove && (
							<button
								type="button"
								className="btn btn-ghost btn-sm text-error"
								aria-label={`Remove variant ${index + 1}`}
								onClick={() => onChange(options.filter((_, i) => i !== index))}
							>
								Remove
							</button>
						)}
					</div>
					<div className="mt-3 flex flex-col gap-1">
						<div className="hidden gap-2 px-1 text-xs text-base-content/60 sm:grid sm:grid-cols-[minmax(0,1fr)_7rem_2rem]">
							<span>Value</span>
							<span>In stock</span>
							<span />
						</div>
						{option.values.map((value, valueIndex) => (
							<div
								key={`${index}-${valueIndex}`}
								className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_2rem]"
							>
								<input
									aria-label={`${option.name || "Variant"} value ${valueIndex + 1}`}
									className="input input-bordered input-sm w-full"
									placeholder="Small"
									value={value.label}
									onChange={(e) =>
										patchValue(index, valueIndex, { ...value, label: e.target.value })
									}
								/>
								<input
									aria-label={`${option.name || "Variant"} ${value.label || "value"} left in stock`}
									type="number"
									min="0"
									step="1"
									className="input input-bordered input-sm w-full"
									placeholder="Unlimited"
									value={value.stock ?? ""}
									onChange={(e) =>
										patchValue(index, valueIndex, {
											...value,
											stock: e.target.value === "" ? null : Number(e.target.value),
										})
									}
								/>
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									aria-label={`Remove ${value.label || "this value"}`}
									onClick={() =>
										patch(index, {
											...option,
											values: option.values.filter((_, i) => i !== valueIndex),
										})
									}
								>
									×
								</button>
							</div>
						))}
						<button
							type="button"
							className="btn btn-ghost btn-xs self-start"
							onClick={() =>
								patch(index, {
									...option,
									values: [...option.values, { label: "", stock: null }],
								})
							}
						>
							Add a value
						</button>
					</div>
				</div>
			))}
			{showAddVariant && options.length < MAX_OPTIONS && (
				<button
					type="button"
					className="btn btn-sm self-start"
					onClick={() => onChange([...options, { name: "", values: [{ label: "", stock: null }] }])}
				>
					Add a variant
				</button>
			)}
			<p className="text-xs text-base-content/50">
				Leave stock blank for as many as you can make. A count holds the value back once it runs
				out.
			</p>
		</div>
	);
}

/** The parcel facts a buyer reads under the price. */
export function PhysicalPolicyFields({
	listing,
	onSave,
	editable,
}: {
	listing: Pick<Listing, "shippingPrice" | "handlingBusinessDays" | "taxCategory">;
	onSave?: (patch: Partial<Listing>) => Promise<void>;
	editable: boolean;
}) {
	const shippingValue = (
		<p className="text-sm">
			{Number(listing.shippingPrice) > 0 ? `$${listing.shippingPrice} to ship` : "Free shipping"}
			<span className="text-base-content/50"> — one charge per order.</span>
		</p>
	);
	const handlingValue = (
		<p className="text-sm">
			{listing.handlingBusinessDays} business {listing.handlingBusinessDays === 1 ? "day" : "days"}{" "}
			to send
			<span className="text-base-content/50"> — the deadline a refund rests on.</span>
		</p>
	);
	const taxValue = (
		<p className="text-sm">
			{PHYSICAL_TAX_CATEGORIES[listing.taxCategory].label}
			<span className="text-base-content/50"> — what sales tax is worked out from.</span>
		</p>
	);

	return (
		<section className="flex flex-col gap-3 border-t border-base-300 pt-3">
			<h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
				Shipping &amp; Policies
			</h2>
			{editable && onSave ? (
				<>
					<InlineField<string>
						label="Shipping"
						saved={listing.shippingPrice}
						renderRead={() => shippingValue}
						renderEdit={(draft, setDraft) => (
							<div>
								<label className="text-xs text-base-content/60" htmlFor="physical-shipping">
									Shipping price
								</label>
								<input
									id="physical-shipping"
									type="number"
									min="0"
									step="0.01"
									inputMode="decimal"
									aria-label="Shipping price"
									className="input input-bordered input-sm w-full"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
								/>
								<p className="text-xs text-base-content/50">
									What a parcel costs you. Enter 0 if you build shipping into the price.
								</p>
							</div>
						)}
						save={(draft) => onSave({ shippingPrice: draft })}
					/>
					<InlineField<number>
						label="Handling time"
						saved={listing.handlingBusinessDays}
						renderRead={() => handlingValue}
						renderEdit={(draft, setDraft) => (
							<div>
								<label className="text-xs text-base-content/60" htmlFor="physical-handling">
									Handling time
								</label>
								<select
									id="physical-handling"
									aria-label="Handling time"
									className="select select-sm select-bordered w-full"
									value={draft}
									onChange={(e) => setDraft(Number(e.target.value))}
								>
									{HANDLING_CHOICES.map((days) => (
										<option key={days} value={days}>
											{days} business {days === 1 ? "day" : "days"}
										</option>
									))}
								</select>
							</div>
						)}
						save={(draft) => onSave({ handlingBusinessDays: draft })}
					/>
					<InlineField<PhysicalTaxCategory>
						label="Tax category"
						saved={listing.taxCategory}
						renderRead={() => taxValue}
						renderEdit={(draft, setDraft) => (
							<div>
								<label className="text-xs text-base-content/60" htmlFor="physical-tax">
									Tax category
								</label>
								<select
									id="physical-tax"
									aria-label="Tax category"
									className="select select-sm select-bordered w-full"
									value={draft}
									onChange={(e) => setDraft(e.target.value as PhysicalTaxCategory)}
								>
									{Object.entries(PHYSICAL_TAX_CATEGORIES).map(([key, category]) => (
										<option key={key} value={key}>
											{category.label}
										</option>
									))}
								</select>
								<p className="text-xs text-base-content/50">
									{PHYSICAL_TAX_CATEGORIES[draft].detail}
								</p>
							</div>
						)}
						save={(draft) => onSave({ taxCategory: draft })}
					/>
				</>
			) : (
				<div className="flex flex-col gap-2">
					{shippingValue}
					{handlingValue}
					{taxValue}
				</div>
			)}
		</section>
	);
}
