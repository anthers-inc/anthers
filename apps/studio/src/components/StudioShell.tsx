// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { consumerOrigin } from "../lib/consumer";

/**
 * Minimal Studio chrome (v1): a wordmark that returns to Anthers, the signed-in
 * handle, and a back-to-site link. The authoring page manages its own content
 * container, so the shell only supplies the header and lets children fill the rest.
 */
export default function StudioShell({ children }: { children: ReactNode }) {
	const { user } = useAuth();
	const site = consumerOrigin();

	return (
		<div className="min-h-screen">
			<header className="border-b border-base-content/10 bg-base-200/40 backdrop-blur">
				<div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
					<a href={site} className="flex items-center gap-2 font-bold">
						<span className="text-xl">🌻</span>
						<span>
							Anthers <span className="text-primary">Studio</span>
						</span>
					</a>
					<div className="flex items-center gap-4 text-sm">
						{user?.username && <span className="text-base-content/60">@{user.username}</span>}
						<a href={site} className="link link-hover inline-flex items-center gap-1">
							Back to Anthers
							<ArrowTopRightOnSquareIcon className="w-4 h-4" />
						</a>
					</div>
				</div>
			</header>
			<main>{children}</main>
		</div>
	);
}
