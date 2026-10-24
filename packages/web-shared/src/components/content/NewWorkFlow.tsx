// SPDX-License-Identifier: Apache-2.0
/**
 * The New Work flow — name, category, type, delivery — the one way a Work is made.
 *
 * 🚨 **The Work is created when its type is chosen, not at the end.** A Work cannot exist
 * without a type, and the type is what the rest of the page is built around; creating at
 * the type step means a draft is in the Works list under its name from that moment, so
 * closing the tab costs nothing and the creator can pick it up from the Catalog. The
 * delivery step is then a PATCH to the row that already exists.
 *
 * ⭐ **Nothing uploads here.** The file, the set, the build and the hosted build belong to
 * the Work's own media area; this flow asks only the questions that decide what that area
 * will be. The delivery choice decides which doors the Work offers and how its media is
 * prepared, so it is a real setting rather than a switch on a page.
 */

import {
	type DeliveryMode,
	defaultDelivery,
	deliveryFlags,
	deliveryModeOf,
	deliveryOffers,
	type WorkCategory,
	workCategory,
} from "@anthers/shared/content";
import {
	ArrowDownTrayIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckIcon,
	CubeIcon,
	PlayCircleIcon,
	SignalIcon,
} from "@heroicons/react/24/outline";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";
import type { ContentType, Work, WorkInput } from "../../lib/types";
import { serializeAccessRows } from "../post/AccessTables";
import { LIBRARY_TYPE_OPTIONS, TypeIcon, typeLabel, WORK_TYPE_DESCRIPTIONS } from "./works";

type Step = "name" | "category" | "type" | "delivery";

const STEPS: { key: Step; label: string }[] = [
	{ key: "name", label: "Name" },
	{ key: "category", label: "Category" },
	{ key: "type", label: "Type" },
	{ key: "delivery", label: "Delivery" },
];

const DELIVERY_COPY: Record<
	DeliveryMode,
	{ label: string; blurb: string; icon: ComponentType<{ className?: string }> }
> = {
	stream: {
		label: "Stream on Anthers",
		blurb: "Readers play or read it here. Ungated streaming is the free catalog.",
		icon: PlayCircleIcon,
	},
	download: {
		label: "Download",
		blurb: "Whoever can open the Work can take the file.",
		icon: ArrowDownTrayIcon,
	},
	both: {
		label: "Stream and Download",
		blurb: "Both doors: played here, and kept by whoever wants the file.",
		icon: SignalIcon,
	},
};

function categoryTypes(category: WorkCategory) {
	return LIBRARY_TYPE_OPTIONS.filter((option) => workCategory(option.value) === category);
}

function categorySubtitle(category: WorkCategory): string {
	return categoryTypes(category)
		.map((option) => option.label)
		.join(", ");
}

interface NewWorkFlowProps {
	onCreated: (work: Work) => void;
}

export default function NewWorkFlow({ onCreated }: NewWorkFlowProps) {
	const [step, setStep] = useState<Step>("name");
	const [name, setName] = useState("");
	const [category, setCategory] = useState<WorkCategory | null>(null);
	const [type, setType] = useState<ContentType | null>(null);
	const [delivery, setDelivery] = useState<DeliveryMode | null>(null);
	const [work, setWork] = useState<Work | null>(null);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		// The name step has a field to type in; every other step announces itself through its
		// heading, which is the only focusable target a screen reader needs to hear the change.
		if (step === "name") nameRef.current?.focus();
		else headingRef.current?.focus();
	}, [step]);

	const stepIndex = STEPS.findIndex((entry) => entry.key === step);
	const offers = type ? deliveryOffers(type) : [];
	const isGoods = type ? workCategory(type) === "goods" : category === "goods";

	const errorFrom = async (
		res: { json: () => Promise<unknown> },
		fallback: string,
	): Promise<string> => {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		return body?.error || fallback;
	};

	const continueFromName = async () => {
		if (!name.trim()) {
			setError("Give the Work a name — you can change it on its page.");
			return;
		}
		setError(null);
		if (work && name.trim() !== work.title) {
			setCreating(true);
			try {
				const res = await client.api.content.works[":id"].$patch({
					param: { id: String(work.id) },
					json: { title: name.trim() },
				});
				if (!res.ok) {
					setError(await errorFrom(res, "Couldn't save the name."));
					return;
				}
				const body = (await res.json()) as { work: Work };
				setWork(body.work);
			} catch {
				setError("Couldn't save the name.");
				return;
			} finally {
				setCreating(false);
			}
		}
		setStep("category");
	};

	const chooseCategory = (next: WorkCategory) => {
		setCategory(next);
		setType(null);
		setDelivery(null);
		setError(null);
		setStep("type");
	};

	const chooseType = async (next: ContentType) => {
		if (creating) return;
		setError(null);
		setType(next);
		const defaults = defaultDelivery(next);
		setDelivery(deliveryModeOf(defaults.streamEnabled, defaults.downloadEnabled));
		setCreating(true);
		try {
			if (!work) {
				const input: WorkInput & { type: ContentType } = {
					type: next,
					title: name.trim(),
					...defaults,
					access: serializeAccessRows([
						{ threshold: 0, label: "Everyone", allow: true, price: "0" },
					]),
				};
				const res = await client.api.content.works.$post({ json: input });
				if (!res.ok) {
					setError(await errorFrom(res, "Couldn't create this Work."));
					return;
				}
				const body = (await res.json()) as { work: Work };
				setWork(body.work);
			} else if (work.type !== next) {
				const res = await client.api.content.works[":id"].$patch({
					param: { id: String(work.id) },
					json: { type: next, ...defaults },
				});
				if (!res.ok) {
					setError(await errorFrom(res, "Couldn't change the Work's type."));
					return;
				}
				const body = (await res.json()) as { work: Work };
				setWork(body.work);
			}
			setStep("delivery");
		} catch {
			setError("Couldn't create this Work.");
		} finally {
			setCreating(false);
		}
	};

	const openTheWork = async () => {
		if (!work || creating) return;
		if (!isGoods) {
			if (!delivery) {
				setError("Choose how this Work reaches people.");
				return;
			}
			setCreating(true);
			try {
				const flags = deliveryFlags(delivery);
				const res = await client.api.content.works[":id"].$patch({
					param: { id: String(work.id) },
					json: flags,
				});
				if (!res.ok) {
					setError(await errorFrom(res, "Couldn't save the delivery choice."));
					return;
				}
				const body = (await res.json()) as { work: Work };
				onCreated(body.work);
				return;
			} catch {
				setError("Couldn't save the delivery choice.");
				return;
			} finally {
				setCreating(false);
			}
		}
		onCreated(work);
	};

	const back = () => {
		setError(null);
		if (step === "delivery") setStep("type");
		else if (step === "type") setStep("category");
		else if (step === "category") setStep("name");
	};

	return (
		<div className="flex flex-col gap-6">
			<ol className="flex flex-wrap items-center gap-2 text-xs">
				{STEPS.map((entry, index) => {
					const done = index < stepIndex;
					const current = index === stepIndex;
					return (
						<li key={entry.key} className="flex items-center gap-2">
							<span
								className={`flex size-5 items-center justify-center rounded-full border text-[10px] ${
									current
										? "border-primary bg-primary text-primary-content"
										: done
											? "border-primary/40 text-primary"
											: "border-base-300 text-base-content/35"
								}`}
							>
								{done ? <CheckIcon className="size-3" /> : index + 1}
							</span>
							<span className={current ? "font-medium text-base-content" : "text-base-content/45"}>
								{entry.label}
							</span>
							{index < STEPS.length - 1 && <span aria-hidden className="h-px w-4 bg-base-300" />}
						</li>
					);
				})}
			</ol>

			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			{step !== "name" && (
				<div>
					<button type="button" className="btn btn-ghost btn-sm" onClick={back}>
						<ArrowLeftIcon className="size-4" />
						Back
					</button>
				</div>
			)}

			{step === "name" && (
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void continueFromName();
					}}
				>
					<div>
						<h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
							Name this Work
						</h2>
						<p className="mt-1 text-sm text-base-content/60">
							A name is all a draft needs to be picked up again. You can change it later.
						</p>
					</div>
					<label className="form-control w-full">
						<span className="label-text mb-1 font-medium">Work Name</span>
						<input
							ref={nameRef}
							className="input input-bordered w-full"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="A name"
							disabled={creating}
						/>
					</label>
					<div>
						<button type="submit" className="btn btn-primary" disabled={creating || !name.trim()}>
							{creating ? "Saving…" : "Continue"}
							<ArrowRightIcon className="size-4" />
						</button>
					</div>
				</form>
			)}

			{step === "category" && (
				<div className="flex flex-col gap-4">
					<div>
						<h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
							What kind of thing is it?
						</h2>
						<p className="mt-1 text-sm text-base-content/60">
							This is the parent of the Work's type. It decides what the next step offers.
						</p>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						{(["digital", "goods"] as const).map((choice) => {
							const Icon = choice === "digital" ? PlayCircleIcon : CubeIcon;
							const chosen = category === choice;
							return (
								<button
									key={choice}
									type="button"
									className={`flex min-h-44 flex-col items-start gap-3 rounded-box border p-5 text-left transition ${
										chosen
											? "border-primary bg-primary/10 ring-2 ring-primary/20 shadow-sm"
											: "border-base-300 bg-base-200 shadow-sm hover:border-primary/50"
									}`}
									onClick={() => chooseCategory(choice)}
								>
									<Icon className="size-10 text-primary" aria-hidden />
									<span className="text-lg font-semibold">
										{choice === "digital" ? "Digital" : "Non-Digital"}
									</span>
									<span className="text-sm text-base-content/60">
										{choice === "digital"
											? "Anything Anthers can stream or download."
											: "Anything that cannot be streamed or downloaded: services and physical goods."}
									</span>
									<span className="mt-auto text-xs text-base-content/45">
										{categorySubtitle(choice)}
									</span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			{step === "type" && category && (
				<div className="flex flex-col gap-4">
					<div>
						<h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
							Choose the type
						</h2>
						<p className="mt-1 text-sm text-base-content/60">
							The type decides the Work's page, its player or reader, and what its media area
							carries.
						</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{categoryTypes(category).map((option) => {
							const chosen = type === option.value;
							return (
								<button
									key={option.value}
									type="button"
									className={`flex min-h-28 flex-col items-start gap-2 rounded-box border p-4 text-left transition ${
										chosen
											? "border-primary bg-primary/10 ring-2 ring-primary/20 shadow-sm"
											: "border-base-300 bg-base-200 shadow-sm hover:border-primary/50"
									} ${creating ? "opacity-60" : ""}`}
									disabled={creating}
									onClick={() => void chooseType(option.value)}
								>
									<TypeIcon type={option.value} className="size-7 text-primary" />
									<span className="font-semibold">{option.label}</span>
									<span className="text-xs text-base-content/60">
										{WORK_TYPE_DESCRIPTIONS[option.value]}
									</span>
								</button>
							);
						})}
					</div>
					{creating && (
						<p className="flex items-center gap-2 text-sm text-base-content/60" role="status">
							<span className="loading loading-spinner loading-sm" />
							Creating the draft…
						</p>
					)}
				</div>
			)}

			{step === "delivery" && type && work && (
				<div className="flex flex-col gap-4">
					<div>
						<h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
							How does it reach people?
						</h2>
						<p className="mt-1 text-sm text-base-content/60">
							{isGoods
								? "This Work is sold and fulfilled rather than streamed or downloaded."
								: "This decides which doors the Work offers and how Anthers prepares its media."}
						</p>
					</div>

					{isGoods ? (
						<div className="flex items-start gap-3 rounded-box border border-base-300 bg-base-200 p-5 shadow-sm">
							<CubeIcon className="size-8 shrink-0 text-primary" aria-hidden />
							<div>
								<p className="font-semibold">Sold and Fulfilled</p>
								<p className="mt-1 text-sm text-base-content/60">
									There is no stream or download for this type. Its terms and details live on the
									Work's page, and how physical goods and services are delivered is not built yet.
								</p>
							</div>
						</div>
					) : (
						<div className="grid gap-3 sm:grid-cols-3">
							{offers.map((mode) => {
								const copy = DELIVERY_COPY[mode];
								const Icon = copy.icon;
								const chosen = delivery === mode;
								return (
									<label
										key={mode}
										className={`flex cursor-pointer flex-col gap-2 rounded-box border p-4 transition ${
											chosen
												? "border-primary bg-primary/10 ring-2 ring-primary/20 shadow-sm"
												: "border-base-300 bg-base-200 shadow-sm hover:border-primary/50"
										}`}
									>
										<input
											type="radio"
											name="delivery"
											className="sr-only"
											checked={chosen}
											onChange={() => setDelivery(mode)}
										/>
										<Icon className="size-7 text-primary" aria-hidden />
										<span className="font-semibold">{copy.label}</span>
										<span className="text-xs text-base-content/60">{copy.blurb}</span>
										{chosen && (
											<span className="mt-auto flex items-center gap-1 text-xs text-primary">
												<CheckIcon className="size-3.5" />
												Selected
											</span>
										)}
									</label>
								);
							})}
						</div>
					)}

					<div className="rounded-lg bg-base-200/60 p-3 text-sm">
						<p className="font-medium">
							A {typeLabel(type)} Work
							{isGoods
								? " · Sold and Fulfilled"
								: delivery
									? ` · ${DELIVERY_COPY[delivery].label}`
									: ""}
						</p>
						<p className="mt-0.5 text-xs text-base-content/50">
							Saved as a private draft. Nothing is public until you release it.
						</p>
					</div>

					<div>
						<button
							type="button"
							className="btn btn-primary"
							disabled={creating || (!isGoods && !delivery)}
							onClick={() => void openTheWork()}
						>
							{creating ? "Opening…" : "Edit Your New Work"}
							<ArrowRightIcon className="size-4" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
