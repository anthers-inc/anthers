// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Studio's front door: **what needs the creator's attention**, and nothing else.
 *
 * 🚨 **This stopped being an overview of everything on 2026-09-11, deliberately.** It used
 * to list the creator's Projects and their posts in two tables and never mention a Work at
 * all — a copy of things they already own, on the one screen with no room for it, while the
 * object carrying every gate, price and Time Pool minute was absent. Projects and Works are
 * managed in the Catalog now and posts have their own tab, which leaves this page free to do
 * the job nothing else can: tell a creator what is wrong.
 *
 * ⭐ **It is EMPTY when nothing is wrong, and that is the feature.** A dashboard that always
 * has something on it is one people stop reading, which costs exactly the days something
 * matters. `buildWorklist` carries the conditions and the reasoning for each.
 *
 * 🚨 **Nothing in the worklist may become a hideable panel** (Parker, 2026-09-11). Payout
 * setup blocks every release a creator will ever attempt, and a released-but-locked Work is
 * invisible from their own side of the glass. The customizable panels that arrive below this
 * are for standing content — earnings, counts, recent activity — where preference is the
 * right input and hiding one costs nothing.
 */

import { PlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { buildWorklist, type WorklistItem } from "../components/content/studio-worklist";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioNewPostUrl, studioNewWorkUrl, studioUrl } from "../lib/studio";
import type { CreatorEarnings, Work } from "../lib/types";

export default function DashboardPage() {
	const { user } = useAuth();
	const [works, setWorks] = useState<Work[]>([]);
	const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
	/** `null` until the status request answers — see `buildWorklist` for why that matters. */
	const [payoutsReady, setPayoutsReady] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let live = true;
		client.api.content.works
			.$get()
			.then(async (res) => (res.ok ? ((await res.json()) as unknown as { works: Work[] }) : null))
			.then((data) => {
				if (live && data) setWorks(data.works);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		if (!user?.isCreator) return;
		let live = true;
		// Both flags, matching the server's own predicate: onboarding can finish while Stripe
		// still declines to send money, and only the second answers "can this creator be paid".
		client.api.payments.stripe.onboard
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const d = (await res.json()) as {
					payoutsEnabled: boolean | null;
					onboardingComplete: boolean | null;
				};
				if (live) setPayoutsReady(d.payoutsEnabled === true && d.onboardingComplete === true);
			})
			.catch(() => {});
		client.api.subscriptions.earnings
			.$get()
			.then((res) => res.json())
			.then((data) => {
				if (live) setEarnings(data as CreatorEarnings);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [user?.isCreator]);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	const worklist = buildWorklist({
		works,
		payoutsReady,
		editUrl: (w) => studioUrl(`/works/${w.publicId ?? w.id}/edit`),
		catalogUrl: studioUrl("/catalog"),
	});

	return (
		<div className="max-w-4xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">Dashboard</h1>

			{worklist.length > 0 ? (
				<section className="mb-8">
					<h2 className="text-lg font-semibold mb-3">Needs you</h2>
					<ul className="flex flex-col gap-2">
						{worklist.map((item) => (
							<WorklistRow key={item.kind} item={item} />
						))}
					</ul>
				</section>
			) : (
				<section className="mb-8 rounded-lg border border-base-300 bg-base-100 p-6">
					<h2 className="font-semibold">Nothing needs you.</h2>
					<p className="mt-1 text-sm text-base-content/60">
						Everything in your Catalog is rated, reachable and released as you left it.
					</p>
					{user?.isCreator && (
						<div className="mt-4 flex flex-wrap gap-2">
							<Link to={studioNewWorkUrl()} className="btn btn-primary btn-sm">
								<PlusIcon className="w-4 h-4" /> New Work
							</Link>
							<Link to={studioNewPostUrl()} className="btn btn-outline btn-sm">
								<PlusIcon className="w-4 h-4" /> New Post
							</Link>
						</div>
					)}
				</section>
			)}

			{/* Earnings. A standing panel rather than an attention item — it is never "wrong",
			    and it is the first thing that becomes hideable when the panels land. */}
			{user?.isCreator && earnings && parseFloat(earnings.total) > 0 && (
				<section className="card bg-base-200">
					<div className="card-body">
						<h2 className="card-title text-lg">Earnings</h2>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
							<div>
								<div className="text-xs text-base-content/50 uppercase">Pool Income</div>
								<div className="text-xl font-bold text-success">${earnings.poolTotal}</div>
							</div>
							<div>
								<div className="text-xs text-base-content/50 uppercase">Support Income</div>
								<div className="text-xl font-bold text-success">${earnings.seedTotal}</div>
							</div>
							<div>
								<div className="text-xs text-base-content/50 uppercase">Total</div>
								<div className="text-xl font-bold">${earnings.total}</div>
							</div>
							<div>
								<div className="text-xs text-base-content/50 uppercase">Supporters</div>
								<div className="text-xl font-bold">{earnings.subscriberCount}</div>
							</div>
						</div>
						{earnings.cycle && (
							<p className="text-xs text-base-content/50 mt-2">
								Cycle:{" "}
								{new Date(earnings.cycle).toLocaleDateString("en-US", {
									month: "long",
									year: "numeric",
								})}
							</p>
						)}
					</div>
				</section>
			)}

			{!user?.isCreator && (
				<p className="text-sm text-base-content/60">
					Turn on creator mode in{" "}
					<Link to="/settings" className="link">
						your account settings
					</Link>{" "}
					to start publishing.
				</p>
			)}
		</div>
	);
}

function WorklistRow({ item }: { item: WorklistItem }) {
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-base-300 bg-base-100 p-3">
			<span
				className={`h-2 w-2 shrink-0 rounded-full ${
					item.severity === "blocking" ? "bg-error" : "bg-warning"
				}`}
				aria-hidden="true"
			/>
			<span className="flex-1 text-sm">{item.message}</span>
			<Link to={item.href} className="link link-primary text-sm whitespace-nowrap">
				{item.action}
			</Link>
		</li>
	);
}
