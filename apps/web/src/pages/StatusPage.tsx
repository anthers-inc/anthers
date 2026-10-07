// SPDX-License-Identifier: Apache-2.0
//
// The public status page. No content module sits behind it — unlike /roadmap and
// /release-notes, whose content is authored and exported from the wiki, this page renders a
// live answer: GET /api/status, polled on a slow interval. The vault's own rule is why
// the page lives here rather than in the wiki: a real-time status page is exactly what
// that rule hands to the app. And a live answer means nothing for the exporter to carry,
// which is what makes it possible for the page to be honest — a cached or authored claim
// about "operational" is the one sentence on Anthers nobody should have to take on faith.
//
// **Everything renders at once — no tabs, no accordions, no lazy sections**, the same
// rule the roadmap and release-notes pages carry: a status page in an incident is skimmed,
// and hiding half of it behind a control is how a reader misses the line that mattered.
//
// **The page says what the data can support and no more.** The outside view's row renders
// its own state (including *unknown* — "not reported recently", which is what a dead
// monitor says), and the page's own reachability is the elephant in the design: if the
// hub is down, this page is down too. So the footer links it, rather than a nav slot —
// a person who cannot reach the site is not browsing its status page — and the page says
// plainly that it is served from the same platform it reports on. The alerting path
// (email from the droplet) never depended on this page being up, which is why the
// honest limitation is affordable.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

const serif = { fontFamily: FONTS.fraunces };

/** Milliseconds between polls. Slow enough to be a non-event for the API, fast enough to be useful. */
const POLL_MS = 30_000;

/** The answer's shape, from services/status.ts — duplicated as a type only, no runtime import. */
interface StatusComponent {
	name: string;
	state: "operational" | "degraded" | "down";
	detail?: string;
}
interface StatusReport {
	state: "operational" | "degraded" | "down";
	external: {
		state: "operational" | "degraded" | "down" | "unknown";
		lastReportAt: string | null;
		detail?: string;
	};
	components: StatusComponent[];
	checkedAt: string;
}

/**
 * State accents. This one, unlike the roadmap's, IS a traffic light — degraded and down
 * are exactly the warning the page exists to deliver, and an incident page that colors
 * nothing is an incident page nobody reads. The pill hues match the rest of the app's
 * success/accent/error vocabulary.
 */
const STATE_STYLE: Record<string, string> = {
	operational: "bg-success/15 text-success border-success/25",
	degraded: "bg-warning/15 text-warning border-warning/30",
	down: "bg-error/15 text-error border-error/30",
	unknown: "bg-base-content/10 text-base-content/60 border-base-content/20",
};

const STATE_LABEL: Record<string, string> = {
	operational: "Operational",
	degraded: "Degraded",
	down: "Down",
	unknown: "Unknown",
};

const HEADLINE: Record<StatusReport["state"], string> = {
	operational: "All systems operational",
	degraded: "Some systems degraded",
	down: "Service disruption",
};

/** The outside view's label, with the page's honest limitation spelled out beside it. */
function ExternalRow({ external }: { external: StatusReport["external"] }) {
	return (
		<div
			className={`rounded-xl border px-5 py-4 ${STATE_STYLE[external.state] ?? STATE_STYLE.unknown}`}
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-semibold">Checked from outside</h3>
				<span className="text-sm font-medium">
					{STATE_LABEL[external.state] ?? STATE_LABEL.unknown}
				</span>
			</div>
			<p className="mt-1 text-sm text-base-content/70">
				{external.detail ??
					(external.state === "operational"
						? "A check running on our identity server answers for the site from outside our hosting platform."
						: "The outside check has not reported recently.")}
				{external.lastReportAt
					? ` Last report ${new Date(external.lastReportAt).toLocaleTimeString()}.`
					: ""}
			</p>
		</div>
	);
}

export default function StatusPage() {
	const [report, setReport] = useState<StatusReport | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let aborted = false;
		async function poll() {
			try {
				const res = await apiFetch("/api/status");
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as StatusReport;
				if (!aborted) {
					setReport(body);
					setFailed(false);
				}
			} catch {
				if (!aborted) setFailed(true);
			}
		}
		poll();
		const timer = setInterval(poll, POLL_MS);
		return () => {
			aborted = true;
			clearInterval(timer);
		};
	}, []);

	return (
		<div>
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Status
						</p>
						<h1
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							{failed
								? "We could not check just now"
								: report
									? HEADLINE[report.state]
									: "Checking…"}
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<Lede>
							What is running and what is not, answered fresh each time this page loads — and
							refreshing every thirty seconds. Anthers is served by the same platform this page
							reports on, so if the platform is down this page goes down with it; when that happens
							a check outside our hosting emails us directly.
						</Lede>
					</Reveal>
				</div>
			</header>

			<Section tint={false}>
				{report && (
					<Reveal>
						<div className="space-y-3">
							<ExternalRow external={report.external} />
							{report.components.map((component) => (
								<div
									key={component.name}
									className={`rounded-xl border px-5 py-4 ${STATE_STYLE[component.state] ?? STATE_STYLE.unknown}`}
								>
									<div className="flex flex-wrap items-baseline justify-between gap-2">
										<h3 className="font-semibold">{component.name}</h3>
										<span className="text-sm font-medium">{STATE_LABEL[component.state]}</span>
									</div>
									{component.detail && (
										<p className="mt-1 text-sm text-base-content/70">{component.detail}</p>
									)}
								</div>
							))}
						</div>
					</Reveal>
				)}
				<Reveal delay={200}>
					<p className="mt-8 text-sm text-base-content/55">
						Something not on this page? Report it at{" "}
						<Link to="/issues" className="link">
							Report an Issue
						</Link>{" "}
						— that page is for things misbehaving that a status row cannot see. The{" "}
						<Link to="/roadmap" className="link">
							roadmap
						</Link>{" "}
						and the{" "}
						<Link to="/release-notes" className="link">
							release notes
						</Link>{" "}
						say what is being built and what has shipped.
					</p>
				</Reveal>
			</Section>
		</div>
	);
}
