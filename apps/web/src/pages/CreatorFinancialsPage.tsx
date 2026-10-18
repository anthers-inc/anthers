// SPDX-License-Identifier: Apache-2.0
//
// Resource: "Your Financials on Anthers" — the creator flagship of the resources
// revamp: one page joining the explanation of how creator financials work to a
// scenario calculator over a few high-level inputs (what they would host, how many
// supporters, what they would sell). It absorbs the two staging calculators it was
// built to replace — `/resources/creator-monetization` and `/resources/video-storage`
// — which now redirect here; the monetization page's closing segment table was
// retired rather than ported, and the storage page's pointers at the retired
// bandwidth tool went out with it (2026-10-18; the resources revamp task).
//
// 🚨 **Every money figure is computed from the model, never typed.** All money math
// lives in `lib/creator-financials.ts` (tested against `fees.ts`'s decimal originals
// and the wiki's generated tables); this file renders what it returns. The SPA never
// imports `fees.ts`; the display copies it reads were pinned by the economics tests
// to the money version. The input defaults are the reader's scenario — a place to
// stand, not a fee anyone charges.
//
// 🚨 **The free tier's pool is the Time Pool Fund, and it is not this file's number.**
// Free accounts' streams of Public Access work pay creators from the Fund — a stated
// share of the charitable remainder after the admin budget, published monthly by its
// ledger and fetched here (`useTimePoolFund`) with the settled placeholder —
// "varies — published monthly" — until the values land. Per the pool ruling, any
// per-hour comparison quotes a paying Badge (Root) as its base; the free slice is
// never a comparison denominator.
//
// 🚨 **A Badge is a subscription purchase, never a gift** (82.01); the verb is give
// and support, and a purchase is a purchase. Anthers keeps no cut of creator money —
// the only deduction is card processing, stated with the take-home number whenever
// the two appear together.

import {
	type BadgeKey,
	badgeLabel,
	STORAGE_PER_GIB_MONTH_LABEL,
	thresholdForBadge,
} from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { useMemo, useState } from "react";
import {
	CalcNotes,
	CalcPageHeader,
	NumberField,
	SegControl,
	StatCard,
} from "../components/calculators/ui";
import { fixed, money as moneyAdaptive } from "../components/calculators/video-model";
import {
	type CatalogVideo,
	type FreeViewerGroup,
	freeViewerRow,
	rungCarrying,
	type SupporterGroup,
	salesCase,
	supporterRow,
	type VideoSizing,
	videoCatalog,
} from "../lib/creator-financials";
import { cent, crossover, money2 } from "../lib/media-month";
import { useTimePoolFund } from "../lib/time-pool-fund";

// ─── The scenario defaults ─────────────────────────────────────────────────────

const PAID_BADGES: Exclude<BadgeKey, "free">[] = ["root", "sprout", "petal", "blossom"];

/** The scenario the reader lands on — modest, whole numbers, nothing that looks like a fee. */
const DEFAULTS = {
	supporters: {
		badge: "root",
		count: 250,
		hoursTotal: 30,
		hoursYou: 4,
		directed: 1,
	} satisfies SupporterGroup,
	freeViewers: { count: 2000, hoursTotal: 20, hoursYou: 1, directed: 0 } satisfies FreeViewerGroup,
	sales: { price: 10, buyers: 40 },
	video: { res: "1080p", fps: 60, master: "h264", masterMbps: 20 } satisfies VideoSizing,
	videoHours: 20,
	otherGiB: 8,
};

// ─── The page ──────────────────────────────────────────────────────────────────

export default function CreatorFinancialsPage() {
	return (
		<div className="max-w-5xl min-w-0 w-full mx-auto px-4 pb-16">
			<CalcPageHeader
				eyebrow="For creators · the financials calculator"
				title="Your Financials on Anthers"
				lede={
					<>
						How money reaches a creator on Anthers, explained and then computed on numbers you
						choose: who would follow you and in what numbers, what you would sell, what you would
						host. Every figure is derived from the same math the checkout runs, nothing is estimated
						where it can be computed, and the parts nobody can compute stand as published gaps
						rather than invented numbers.
					</>
				}
			/>
			<Reveal>
				<Explanation />
			</Reveal>
			<Reveal delay={100}>
				<div className="card bg-base-100 border border-base-300 mt-4">
					<div className="card-body p-5 sm:p-6">
						<Calculator />
					</div>
				</div>
			</Reveal>
			<Reveal delay={150}>
				<div className="card bg-base-100 border border-base-300 mt-4">
					<div className="card-body p-5 sm:p-6">
						<StoragePanel />
					</div>
				</div>
			</Reveal>
			<Notes />
		</div>
	);
}

// ─── The explanation ───────────────────────────────────────────────────────────

function Explanation() {
	const fund = useTimePoolFund();

	return (
		<div className="card bg-base-100 border border-base-300">
			<div className="card-body p-5 sm:p-6 space-y-5">
				<div>
					<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40 mb-2">
						How creator financials work
					</h2>
					<p className="text-sm text-base-content/70 leading-relaxed">
						Money reaches a creator on Anthers three ways, and none of them carries a platform cut:
						the only deduction anywhere in what you take home is the card processor's at-cost fee,
						named on every line where it applies.
					</p>
				</div>

				<ol className="text-sm text-base-content/70 leading-relaxed space-y-4 list-decimal pl-5 max-w-3xl">
					<li>
						<span className="font-semibold text-base-content/85">
							A supporter holding a Badge pays a monthly subscription to Anthers.
						</span>{" "}
						Half of what they give funds their <b className="text-base-content">Time Pool</b>, which
						they split across everything they spend time with,{" "}
						<b className="text-base-content">proportionally by time</b> — a minute is a minute,
						whether they spent it watching, listening, reading or playing. Your share of their time
						is your slice of their pool.
					</li>
					<li>
						<span className="font-semibold text-base-content/85">
							Their support they can point at you by name.
						</span>{" "}
						A supporter may direct any amount at you monthly. It rides their one monthly charge, and
						its only cost is that charge's pro-rata slice of the card fee — after that it is yours,
						in full.
					</li>
					<li>
						<span className="font-semibold text-base-content/85">A purchase is a purchase.</span>{" "}
						When somebody buys a Work from you, the charge settles on its own; the card fee sits
						inside the price, and everything past it reaches you. Sales tax is the only thing ever
						added on top, and it goes to the jurisdiction, not to us.
					</li>
				</ol>

				{/* The free-account line — the piece this build waited on. The published
				    pool's share renders from the Fund's ledger, exactly as the signup
				    ladder fetches its values; the free slice never serves as a
				    comparison denominator. */}
				<div className="rounded-xl bg-success/[0.07] border border-success/20 p-4 text-sm text-base-content/75 leading-relaxed space-y-2">
					<p>
						<b className="text-base-content">And the people who pay nothing?</b> A free account
						streams Public Access work — {FREE_PUBLIC_ACCESS_HOURS} hours a month, free forever —
						and the time those accounts spend with you still pays. It is paid from the{" "}
						<b className="text-base-content">Time Pool Fund</b>: a stated share of what is left of
						support given to Anthers after the admin budget, published monthly and divided across
						the month's active free accounts. Anthers funds it; the viewer does not, and no ads, no
						tracking and no paywall stand behind it.
					</p>
					<p className="text-base-content/80">
						{fund ? (
							<>
								The Fund's latest published figures:{" "}
								<b className="font-mono text-success">{moneyAdaptive(fund.poolAmount)}</b> for the
								pool in {fund.billingCycle}, which is{" "}
								<b className="font-mono text-success">{moneyAdaptive(fund.slicePerAccount)}</b> for
								each active free account. The figure moves monthly with what is given — it is
								published every month, and so is its history.
							</>
						) : (
							<>The Fund's per-account slice varies — published monthly.</>
						)}
					</p>
					<p className="text-base-content/60">
						What an hour of attention is worth comes only from the pools above: a supporter's pool
						divided by their whole month's time is the per-hour rate their watching pays you,
						computed per row in the calculator below. Where a comparison between free and paying is
						ever stated, a paying Badge — Root, the smallest — carries its base, and the Fund's own
						figure is quoted as itself, never as somebody else's denominator.
					</p>
				</div>

				<p className="text-sm text-base-content/60 leading-relaxed max-w-3xl">
					What you would host is the one place you spend money: every Badged account carries a
					bundled storage allowance, and every stored byte above rung arithmetic — an at-cost charge
					from Root onward, at the vendor's rate, with no markup. Delivery has no bill anywhere on
					it: there is no bandwidth fee, and downloads are unlimited and free.
				</p>
			</div>
		</div>
	);
}

// ─── The calculator ────────────────────────────────────────────────────────────

function Calculator() {
	const [supporters, setSupporters] = useState<SupporterGroup>(DEFAULTS.supporters);
	const [freeViewers, setFreeViewers] = useState<FreeViewerGroup>(DEFAULTS.freeViewers);
	const [price, setPrice] = useState(DEFAULTS.sales.price);
	const [buyers, setBuyers] = useState(DEFAULTS.sales.buyers);

	const fund = useTimePoolFund();
	const m = useMemo(() => {
		const sup = supporterRow(supporters);
		const free = freeViewerRow(freeViewers, fund?.slicePerAccount ?? null);
		const sales = salesCase(price, buyers);
		const salesRev = cent((sales.reachAnthers ?? 0) * sales.buyers);
		const known = cent(sup.revenue + (free.revenue ?? 0) + salesRev);
		const poolShare = cent(sup.tpEarn * sup.count);
		const directShare = cent(sup.directedNet * sup.count);
		const byTime = free.revenue === null ? null : cent(free.revenue);
		return { sup, free, sales, salesRev, known, poolShare, directShare, byTime };
	}, [supporters, freeViewers, price, buyers, fund]);

	const totalHours = m.sup.hoursYou + m.free.hoursYou;
	// The per-hour rate is support-only, on the hours that back it — a supporter's
	// revenue divided by their own hours with you. Folding the free viewers' hours
	// in would pair a full denominator with a revenue the gap above excludes.
	const effRate = m.sup.hoursYou > 0 ? m.sup.revenue / m.sup.hoursYou : 0;

	const set = <K extends keyof SupporterGroup>(k: K, v: SupporterGroup[K]) =>
		setSupporters((p) => ({ ...p, [k]: v }));

	return (
		<>
			<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
				The calculator
			</h2>
			<p className="text-sm text-base-content/60 max-w-2xl mt-2 leading-relaxed">
				Name an audience, a price and a catalog below. The groups are deliberately few: one round of
				paid supporters, the free accounts who stream your Public Access work, and your sales. What
				reaches you is computed exactly; what cannot be is shown as a gap.
			</p>

			<div className="grid grid-cols-1 gap-6 mt-6 md:grid-cols-3">
				{/* Supporters — the Badge they hold */}
				<div className="space-y-4">
					<h3 className="text-sm font-semibold text-base-content/80">Your supporters</h3>
					<NumberField
						label="Supporters"
						hint="people a month"
						value={supporters.count}
						onChange={(v) => set("count", Math.max(0, Math.round(v)))}
						min={0}
						step={10}
					/>
					<div>
						<span className="block text-sm text-base-content/70 mb-2">The Badge they hold</span>
						<SegControl
							ariaLabel="The Badge your supporters hold"
							value={supporters.badge}
							onChange={(v) => set("badge", v)}
							options={PAID_BADGES.map((b) => ({ value: b, label: badgeLabel(b) }))}
						/>
					</div>
					<NumberField
						label="Their total time a month"
						hint="everything they watch"
						value={supporters.hoursTotal}
						onChange={(v) => set("hoursTotal", Math.max(0, Math.round(v)))}
						min={0}
						step={1}
						suffix="hrs"
					/>
					<NumberField
						label="Of that, time with you"
						value={supporters.hoursYou}
						onChange={(v) => {
							set("hoursYou", Math.max(0, Math.round(v)));
						}}
						min={0}
						step={0.5}
						suffix="hrs"
					/>
					<NumberField
						label="Directed at you"
						hint={`by each, any amount`}
						value={supporters.directed}
						onChange={(v) => set("directed", Math.max(0, v))}
						min={0}
						step={0.5}
						prefix="$"
						suffix="/mo"
					/>
					<p className="text-base-content/40 text-xs leading-relaxed">
						Each rides one monthly charge — the Badge amount they hold plus what they direct at you
						— so the card fee is paid once and split pro-rata; your side nets its exact slice.
					</p>
				</div>

				{/* Free viewers — the Fund's published slice */}
				<div className="space-y-4">
					<h3 className="text-sm font-semibold text-base-content/80">Free viewers of your work</h3>
					<NumberField
						label="Free viewers"
						hint="active in the month"
						value={freeViewers.count}
						onChange={(v) => setFreeViewers((p) => ({ ...p, count: Math.max(0, Math.round(v)) }))}
						min={0}
						step={10}
					/>
					<NumberField
						label="Their total time a month"
						value={freeViewers.hoursTotal}
						onChange={(v) =>
							setFreeViewers((p) => ({ ...p, hoursTotal: Math.max(0, Math.round(v)) }))
						}
						min={0}
						step={1}
						suffix="hrs"
					/>
					<NumberField
						label="Of that, time with you"
						value={freeViewers.hoursYou}
						onChange={(v) =>
							setFreeViewers((p) => ({ ...p, hoursYou: Math.max(0, Math.round(v)) }))
						}
						min={0}
						step={0.5}
						suffix="hrs"
					/>
					<NumberField
						label="Directed at you"
						hint="optional"
						value={freeViewers.directed ?? 0}
						onChange={(v) => setFreeViewers((p) => ({ ...p, directed: Math.max(0, v) }))}
						min={0}
						step={0.5}
						prefix="$"
						suffix="/mo"
					/>
					<p className="text-base-content/40 text-xs leading-relaxed">
						{fund ? (
							<>
								Their streams pay from the Time Pool Fund — {moneyAdaptive(fund.slicePerAccount)}{" "}
								per active free account this month's publication, split by time.
							</>
						) : (
							<>
								Their streams pay from the Time Pool Fund; the per-account slice varies — published
								monthly.
							</>
						)}
					</p>
				</div>

				{/* Sales */}
				<div className="space-y-4">
					<h3 className="text-sm font-semibold text-base-content/80">Your sales</h3>
					<NumberField
						label="A Work's price"
						value={price}
						onChange={setPrice}
						min={0}
						step={1}
						prefix="$"
					/>
					<NumberField
						label="Buyers a month"
						value={buyers}
						onChange={setBuyers}
						min={0}
						step={5}
					/>
					<div className="rounded-lg bg-base-200/50 border border-base-300 p-3 text-xs leading-relaxed text-base-content/60">
						<p>
							Per sale of {moneyAdaptive(price)}: the card fee is {moneyAdaptive(m.sales.card)}, so{" "}
							{moneyAdaptive(m.sales.reachAnthers)} reaches you.
						</p>
						{m.sales.storefrontWins && (
							<p className="mt-1.5 text-warning">
								Conceded: at this price the storefront wins outright — below{" "}
								{moneyAdaptive(crossover())} a percentage cut that absorbs processing beats the flat
								card fee. The crossover is computed from the card rate, and this row loses to it
								rather than hiding it.
							</p>
						)}
					</div>
				</div>
			</div>

			{/* The readout */}
			<div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
				<StatCard
					label="Reaches you, monthly"
					value={money2(m.known)}
					tone="money"
					sub="Computed to the cent; card processing named where it applies."
				/>
				<StatCard
					label="Paid by time spent"
					value={money2(cent(m.poolShare + (m.byTime ?? 0)))}
					tone="time"
					sub={
						m.byTime === null && m.free.count > 0
							? `${cnt(m.sup.hoursYou)} supporter hours with you; the free viewers' share is the gap below`
							: `${cnt(totalHours)} hours with you a month`
					}
				/>
				<StatCard
					label="Given to you by name"
					value={money2(cent(m.directShare + m.salesRev))}
					sub={`Direct support and sales — no platform cut, named fees.`}
				/>
			</div>

			{/* The stated gap, when the Fund's values are not in hand. */}
			{m.free.count > 0 && m.byTime === null && (
				<p className="mt-3 text-sm text-base-content/70 leading-relaxed border-l-4 border-warning/50 px-3 py-2 bg-warning/[0.06]">
					Of your {cnt(m.free.count)} free viewers' time, the money rides the Time Pool Fund — the
					published slice was not in hand when this page loaded, so their total stands below the
					headline figure rather than inside it. The slice varies — published monthly. Conceded to
					the gap, not estimated.
				</p>
			)}

			{/* The verdict — the honest prose, computed */}
			<div className="mt-5 border-l-4 border-primary/40 bg-base-200/60 px-4 py-3 text-sm text-base-content/80 leading-relaxed space-y-2">
				<p>
					{cnt(m.sup.count)} supporters holding {m.sup.label} give{" "}
					{money2(cent(thresholdForBadge(m.sup.badge) * m.sup.count))}
					/mo to Anthers in all — half of which funds their Time Pools they split by time, the rest
					funds the charitable programs; what they direct at you arrives net of the fee share their
					charge already paid. Anthers keeps <b>$0</b> of anything that reaches you.
				</p>
				<p className="text-base-content/70">
					Your monthly revenue in this scenario: <b>{money2(m.known)}</b> — {money2(m.poolShare)} by
					time, {money2(m.directShare)} directed, {money2(m.salesRev)} by sale
					{m.byTime === null && m.free.count > 0
						? "; the free viewers' share stands as the gap above"
						: ""}
					. That is <b>{moneyAdaptive(Math.round(effRate * 1000) / 1000)}</b> per hour of your
					supporters' attention, their revenue against their own hours with you.
				</p>
				<p className="text-base-content/60 text-xs">
					The pools are real and modest: the whole time side of a Badge is half its amount, and the
					Fund's slice is small today. Sizes are what they are; the rates beneath them are the
					model's, and they hold at any scale — the page refuses to model a projection of the
					platform, and so does the calculator.
				</p>
			</div>
		</>
	);
}

function cnt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

// ─── Storage — what hosting costs ──────────────────────────────────────────────

function StoragePanel() {
	const [video, setVideo] = useState<VideoSizing>(DEFAULTS.video);
	const [videoHours, setVideoHours] = useState(DEFAULTS.videoHours);
	const [otherGiB, setOtherGiB] = useState(DEFAULTS.otherGiB);

	const videoCat = useMemo<CatalogVideo>(
		() => videoCatalog(video, videoHours),
		[video, videoHours],
	);
	const catalogGiB = videoCat.totalGiB + Math.max(0, otherGiB);
	const carrying = useMemo(() => rungCarrying(catalogGiB), [catalogGiB]);

	const setVideo2 = <K extends keyof VideoSizing>(k: K, v: VideoSizing[K]) =>
		setVideo((p) => ({ ...p, [k]: v }));

	return (
		<>
			<h2 className="font-mono text-xs uppercase tracking-[0.14em] text-base-content/40">
				What you would host
			</h2>
			<p className="text-sm text-base-content/60 max-w-2xl mt-2 mb-5 leading-relaxed">
				Storage is the only infrastructure charge anyone is billed for, and it is billed{" "}
				<em>above the bundled allowance</em> — every stored byte past your Badge's share bills at
				cost, from Root onward. There is no gated-vs-free catalog: the rule is about your allowance,
				not about who may watch.
			</p>

			<div className="grid grid-cols-1 gap-6 md:grid-cols-2">
				<div className="space-y-4">
					<NumberField
						label="Hours of video you would host"
						value={videoHours}
						onChange={setVideoHours}
						min={0}
						step={1}
						suffix="source hrs"
					/>
					<div className="grid grid-cols-2 gap-3">
						<div>
							<span className="block text-sm text-base-content/70 mb-2">Master size</span>
							<SegControl
								ariaLabel="Master resolution"
								value={video.res}
								onChange={(v) => setVideo2("res", v)}
								options={["720p", "1080p", "1440p", "2160p"].map((r) => ({
									value: r as VideoSizing["res"],
									label: r,
								}))}
							/>
						</div>
						<div>
							<span className="block text-sm text-base-content/70 mb-2">Framerate</span>
							<SegControl
								ariaLabel="Master framerate"
								value={video.fps}
								onChange={(v) => setVideo2("fps", v)}
								options={[
									{ value: 24 as const, label: "24 fps" },
									{ value: 30 as const, label: "30 fps" },
									{ value: 60 as const, label: "60 fps" },
								]}
							/>
						</div>
					</div>
					<div>
						<span className="flex justify-between items-baseline text-sm text-base-content/70 mb-2">
							<span>Original export</span>
							<span className="text-xs font-mono text-base-content/40">
								the original is stored as-is
							</span>
						</span>
						<SegControl
							ariaLabel="Original export format"
							value={video.master}
							onChange={(v) => setVideo2("master", v)}
							options={[
								{ value: "h264" as const, label: "H.264" },
								{ value: "h265" as const, label: "H.265" },
								{ value: "prores" as const, label: "ProRes" },
								{ value: "custom" as const, label: "Custom" },
							]}
						/>
					</div>
					{video.master === "custom" && (
						<NumberField
							label="Your master's video bitrate"
							hint="audio carried on top; ladder unchanged"
							value={video.masterMbps}
							onChange={(v) => setVideo2("masterMbps", Math.max(0, v))}
							min={0}
							step={1}
							suffix="Mbps"
						/>
					)}
					<NumberField
						label="Everything else — audio, games, writing, files"
						value={otherGiB}
						onChange={setOtherGiB}
						min={0}
						step={1}
						suffix="GiB"
					/>
				</div>

				<div className="space-y-3">
					<div className="rounded-xl bg-base-200 border border-base-300 p-4">
						<p className="text-xs uppercase tracking-wide text-base-content/50">Your catalog</p>
						<p className="mt-1 font-mono text-2xl font-bold tabular-nums leading-none">
							{fixed(catalogGiB, 1)}{" "}
							<span className="text-sm font-medium text-base-content/50">GiB</span>
						</p>
						<p className="mt-2 text-xs text-base-content/55">
							{fixed(videoCat.masterGiB, 1)} GiB of it is the original masters,{" "}
							{fixed(videoCat.ladderGiB, 1)} GiB the delivery ladders — the master is kept as-is,
							and a full AV1 ladder down to 240p30 is stored alongside it,{" "}
							{(videoCat.masterShare * 100).toFixed(0)}% master.
						</p>
					</div>
					<div
						className={`rounded-xl border p-4 ${
							carrying.topUp
								? "bg-warning/[0.08] border-warning/30"
								: "bg-success/[0.08] border-success/25"
						}`}
					>
						<p className="text-xs uppercase tracking-wide text-base-content/50">
							The Badge that carries it
						</p>
						<p className="mt-1 font-mono text-2xl font-bold tabular-nums leading-none">
							{carrying.badge === "free" ? "Free" : badgeLabel(carrying.badge)}
							<span className="ml-2 text-sm font-medium text-base-content/50 font-sans">
								{fixed(carrying.allowance, 0)} GiB bundled
							</span>
						</p>
						{carrying.topUp ? (
							<p className="mt-2 text-base-content/70 leading-relaxed">
								{fixed(carrying.topUp.gib, 1)} GiB sits past the ladder's top allowance and bills at
								cost:{" "}
								<b className="font-mono text-warning">{moneyAdaptive(carrying.topUp.monthly)}</b>
								/mo, the provider's rate ({STORAGE_PER_GIB_MONTH_LABEL} per GiB-month) — the at-cost
								line, from Root onward.
							</p>
						) : (
							<p className="mt-2 text-base-content/70 leading-relaxed">
								{carrying.badge === "free" ? (
									<>
										The combined free floor carries it — nothing to pay, no Badge needed. The
										allowance is also your own files' room.
									</>
								) : (
									<>
										Its allowance holds the whole catalog — nothing beyond the Badge itself to pay
										for hosting. Past an allowance, the bytes bill at cost (
										{STORAGE_PER_GIB_MONTH_LABEL} per GiB-month) and never become a reason to climb.
									</>
								)}
							</p>
						)}
					</div>
					<p className="text-base-content/40 text-xs leading-relaxed">
						Sizes assume the delivery ladder's reference bitrates at good quality, master audio
						carried at its rate, and that the original is never re-encoded. A ProRes master will
						swamp the ladder — that is the point of showing it as-is.
					</p>
				</div>
			</div>
		</>
	);
}

// ─── The notes ─────────────────────────────────────────────────────────────────

function Notes() {
	return (
		<CalcNotes>
			<p>
				Every Anthers figure on this page is computed from the checkout's own math — the float
				copies of the decimal originals, pinned by test to the money version, the same arrangement
				every calculator here runs. The free tier's pool is not a constant to quote: it is the
				published Time Pool Fund, fetched from its ledger when the page requests it, and it is left
				standing as a stated gap when the fetch comes back empty. Planning model; approximate, not
				for invoicing.
			</p>
			<p>
				Storage's geometry — the master as-is plus the AV1 delivery ladder down to 240p30 — is the
				same ladder model the signup matrix reads, reference bitrates beside the model, and the
				at-cost rate is the vendor's own ({STORAGE_PER_GIB_MONTH_LABEL} per GiB-month, Cloudflare
				R2), passed through with no markup, from Root onward. What a free account carries is 25 GiB
				combined, catalog and kept files together. Past the top rung's 200 GiB, the excess bills at
				the same at-cost rate.
			</p>
			<p>
				What an hour of attention pays in this model depends on who is paying it: a pool is a
				person's, and its per-hour worth is that person's whole month divided by their time.
				Per-hour figures here are computed from the pools, and comparisons between free and paying
				accounts are not published as ratios — a paying Badge's pool carries the base, and the free
				tier's published slice speaks for itself.
			</p>
			<p>
				The head-to-head per-price table against incumbent platforms is the{" "}
				<em>How Our Pay Compares</em> resource, and the wiki's <em>What a Creator Takes Home</em>{" "}
				pages carry the fixed cases in prose. The support model behind every line on this page is
				the model the checkout charges against — hold any figure you doubt against{" "}
				<code>@anthers/shared</code>.
			</p>
		</CalcNotes>
	);
}
