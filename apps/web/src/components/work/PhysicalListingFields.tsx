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
import type { ReactNode } from "react";
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
 * to order. The caller edits one variant at a time; adding and removing variants belongs to
 * the storefront's header and row controls, not to this table.
 */
export function PhysicalVariantEditor({
	options,
	onChange,
}: {
	options: ListingOption[];
	onChange: (next: ListingOption[]) => void;
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
		</div>
	);
}

/** One fact in the policy join: a label and its value, side by side on a narrow panel
 * and stacked in a column when there is room for three. A field that opens for editing
 * takes the whole row, so its control is never squeezed into a third of the panel. */
function PolicyFact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 items-baseline justify-between gap-3 border-t border-base-300 py-1.5 first:border-t-0 first:pt-0 last:pb-0 has-[[data-editing]]:block has-[[data-editing]]:space-y-1 has-[[data-editing]]:pt-2 has-[[data-editing]]:lg:col-span-3 has-[[data-editing]]:lg:border-l-0 has-[[data-editing]]:lg:border-t has-[[data-editing]]:lg:px-0 has-[[data-editing]]:lg:pt-2 lg:block lg:border-t-0 lg:border-l lg:px-4 lg:py-0 lg:first:border-l-0 lg:first:pl-0 lg:last:pr-0">
			<p className="text-xs font-semibold uppercase tracking-wider text-base-content/50">{label}</p>
			<div className="min-w-0 text-sm lg:mt-1">{children}</div>
		</div>
	);
}

/**
 * The parcel facts a buyer reads under the price, as one join rather than three
 * sentences: the shipping cost, the handling time and the tax category are three short
 * values, each named by its own label. Three columns where the right column is wide
 * enough for them, label-and-value rows where it is not — the panel's right column is a
 * third of the card at a narrow window, which is narrower than a phone's whole width.
 * The creator reads and edits the same facts, so the pencils sit where the buyer's
 * values do.
 */
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
		<p>{Number(listing.shippingPrice) > 0 ? `$${listing.shippingPrice}` : "Free"}</p>
	);
	const handlingValue = (
		<p>
			{listing.handlingBusinessDays} {listing.handlingBusinessDays === 1 ? "day" : "days"}
		</p>
	);
	const taxValue = <p>{PHYSICAL_TAX_CATEGORIES[listing.taxCategory].label}</p>;

	return (
		<section
			className="flex flex-col gap-2 border-t border-base-300 pt-3"
			aria-label="Shipping and policies"
			data-testid="physical-policies"
		>
			{editable && onSave ? (
				<div className="grid grid-cols-1 lg:grid-cols-3">
					<PolicyFact label="Shipping cost">
						<InlineField<string>
							label="Shipping cost"
							saved={listing.shippingPrice}
							renderRead={() => shippingValue}
							renderEdit={(draft, setDraft) => (
								<div>
									<input
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
					</PolicyFact>
					<PolicyFact label="Handling time">
						<InlineField<number>
							label="Handling time"
							saved={listing.handlingBusinessDays}
							renderRead={() => handlingValue}
							renderEdit={(draft, setDraft) => (
								<div>
									<select
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
					</PolicyFact>
					<PolicyFact label="Tax category">
						<InlineField<PhysicalTaxCategory>
							label="Tax category"
							saved={listing.taxCategory}
							renderRead={() => taxValue}
							renderEdit={(draft, setDraft) => (
								<div>
									<select
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
					</PolicyFact>
				</div>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-3">
					<PolicyFact label="Shipping cost">{shippingValue}</PolicyFact>
					<PolicyFact label="Handling time">{handlingValue}</PolicyFact>
					<PolicyFact label="Tax category">{taxValue}</PolicyFact>
				</div>
			)}
		</section>
	);
}
