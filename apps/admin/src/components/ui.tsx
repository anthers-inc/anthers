// SPDX-License-Identifier: Apache-2.0
/** The few layout pieces every admin screen shares, so the sections read as one app. */
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

export function PageHeader({
	title,
	description,
	onRefresh,
	loading,
}: {
	title: string;
	description?: ReactNode;
	onRefresh?: () => void;
	loading?: boolean;
}) {
	return (
		<div className="mb-6 flex items-start justify-between gap-4">
			<div>
				<h1 className="text-2xl font-bold">{title}</h1>
				{description && <p className="mt-1 text-sm text-base-content/60">{description}</p>}
			</div>
			{onRefresh && (
				<button type="button" className="btn btn-ghost btn-sm gap-2" onClick={onRefresh} disabled={loading}>
					<ArrowPathIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
					Refresh
				</button>
			)}
		</div>
	);
}

export function SectionHeading({ children }: { children: ReactNode }) {
	return <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
}

export function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="text-xs uppercase tracking-wide text-base-content/50">{title}</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
			{sub && <div className="mt-0.5 text-xs text-base-content/60">{sub}</div>}
		</div>
	);
}

export function ErrorAlert({ children }: { children: ReactNode }) {
	return (
		<div role="alert" className="alert alert-error mb-4">
			<span>{children}</span>
		</div>
	);
}

export function Loading() {
	return (
		<div className="flex justify-center py-16">
			<LoadingSpinner size="lg" />
		</div>
	);
}
