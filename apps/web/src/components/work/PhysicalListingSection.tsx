// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noArrayIndexKey: a variant and its values are positional rows with no ids; every control addresses the position.
/**
 * The Manage tab's Selling section for a physical good — shipping, handling and tax, the
 * answers a good needs that a digital Work never does (Parker's physical-goods model,
 * 2026-10-26).
 *
 * ⭐ **The buyer's variants are the fourth answer, and they live behind the media area's
 * pencil** (`PhysicalVariantsSection`), beside the store panel they configure, rather than
 * at the bottom of this tab (Parker, 2026-10-28). Shipping, handling and tax stay here
 * because they describe the parcel rather than what the buyer picks.
 *
 * A creator fulfills their own orders. The platform's job is to know what a parcel costs
 * to send, how long the good takes to leave, what the good is for tax, and what choices
 * the buyer makes before paying — so the checkout can be honest without asking anybody
 * anything. What is *not* here is the price: that is the Work's own access row, edited by
 * the price field that already edits it.
 *
 * Shipping is flat and per order, deliberately: a creator charges what a parcel costs
 * them, and two of one good still go in one box. Zero is a real answer — shipping built
 * into the price — and reads as a stated fact rather than as missing data.
 *
 * Options are a short ordered list of names with values, validated as a shape rather than
 * against a vocabulary: a creator may offer Scent as readily as Size, and the platform has
 * no business deciding which names are the real ones.
 *
 * ⭐ **One listing row, several editing surfaces.** `useListing` re-reads the row immediately
 * before every save and writes only the slice its caller changed, because the route
 * replaces the whole listing: a component holding a copy from before another surface saved
 * would silently undo that save.
 */

import { PHYSICAL_TAX_CATEGORIES, type PhysicalTaxCategory } from "@anthers/shared/tax-codes";
import { InlineField } from "./Editing";
import { type ListingOption, type ListingValue, useListing } from "./physical-listing";
import { WORK_DETAILS_HEADING_CLASS } from "./WorkLayout";

/** The range the server clamps into; the picker offers the same numbers. */
const HANDLING_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** How many variants a good may offer — the service's own ceiling. */
const MAX_OPTIONS = 3;

/**
 * The variant builder: names down the side, each with its values and a stock count.
 *
 * A blank count means unlimited, which is the ordinary case for a creator making things
 * to order — so blank is where the field starts rather than a count nobody meant.
 */
function VariantEditor({
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
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
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
						<button
							type="button"
							className="btn btn-ghost btn-sm text-error"
							aria-label={`Remove variant ${index + 1}`}
							onClick={() => onChange(options.filter((_, i) => i !== index))}
						>
							Remove
						</button>
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
			{options.length < MAX_OPTIONS && (
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

/**
 * The buyer's variants, opened by the media area's pencil.
 *
 * The content is the store panel's own choices: a variant is a name the buyer picks
 * under, and each value is one thing they can take.
 */
export function PhysicalVariantsSection({ workId }: { workId: number }) {
	const { listing, loadError, save } = useListing(workId);

	if (loadError) return <p className="text-sm text-error">{loadError}</p>;
	if (!listing) return <p className="text-sm text-base-content/50">Reading the variants…</p>;

	return (
		<InlineField<ListingOption[]>
			label="Variants"
			saved={listing.options}
			renderRead={() =>
				listing.options.length === 0 ? (
					<p className="text-sm text-base-content/40">No variants — a buyer takes it as it is.</p>
				) : (
					<ul className="flex flex-col gap-1 text-sm">
						{listing.options.map((option) => (
							<li key={option.name}>
								<span className="font-medium">{option.name}:</span>{" "}
								<span className="text-base-content/70">
									{option.values.map((value) => value.label).join(", ")}
								</span>
							</li>
						))}
					</ul>
				)
			}
			renderEdit={(draft, setDraft) => <VariantEditor options={draft} onChange={setDraft} />}
			save={(options) => save({ options })}
		/>
	);
}

export default function PhysicalListingSection({ workId }: { workId: number }) {
	const { listing, loadError, save } = useListing(workId);

	if (loadError) return <p className="text-sm text-error">{loadError}</p>;
	if (!listing) return <p className="text-sm text-base-content/50">Reading the selling details…</p>;

	return (
		<section className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Shipping</h3>
				<InlineField<string>
					label="Shipping"
					saved={listing.shippingPrice}
					renderRead={() => (
						<p className="text-sm">
							{Number(listing.shippingPrice) > 0
								? `$${listing.shippingPrice} to ship`
								: "Free shipping"}
							<span className="text-base-content/50"> — one charge per order, not per item.</span>
						</p>
					)}
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
					save={(draft) => save({ shippingPrice: draft })}
				/>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Handling</h3>
				<InlineField<number>
					label="Handling time"
					saved={listing.handlingBusinessDays}
					renderRead={() => (
						<p className="text-sm">
							{listing.handlingBusinessDays} business{" "}
							{listing.handlingBusinessDays === 1 ? "day" : "days"} to send
							<span className="text-base-content/50">
								{" "}
								— the deadline a buyer&rsquo;s refund rests on.
							</span>
						</p>
					)}
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
							<p className="text-xs text-base-content/50">
								How long it takes you to get it out the door. Weekends don&rsquo;t count.
							</p>
						</div>
					)}
					save={(draft) => save({ handlingBusinessDays: draft })}
				/>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Tax</h3>
				<InlineField<PhysicalTaxCategory>
					label="Tax category"
					saved={listing.taxCategory}
					renderRead={() => (
						<p className="text-sm">
							{PHYSICAL_TAX_CATEGORIES[listing.taxCategory].label}
							<span className="text-base-content/50"> — what sales tax is worked out from.</span>
						</p>
					)}
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
					save={(draft) => save({ taxCategory: draft })}
				/>
			</section>
		</section>
	);
}
