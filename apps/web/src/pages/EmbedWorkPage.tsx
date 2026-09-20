// SPDX-License-Identifier: Apache-2.0
/**
 * `/embed/:token` — a share link rendered as a player, for a third party to iframe.
 *
 * An embed is **a share link that renders in a player**, settled 2026-09-20: one share
 * affordance, two output shapes — a *Link* or an *Embed* — and both follow the identical
 * mechanism. The token is the same opaque string a `Link` carries; this page only changes
 * what it renders into, not what it opens. Every question about what a viewer may see is
 * answered by the same resolver, against the same `?share=` token, that answers it on the
 * full Work page — so metering, the sharer's relay budget, attribution and the gated /
 * priced / Adult refusals are all inherited rather than re-decided here.
 *
 * ⚠️ **This is deliberately a second rendering of a deliverable, not a second path to it.**
 * The wiki's *Share Links* forbids a second resolution path: `/s/:token` answers *where*,
 * never *whether*, and hands off to the canonical page. The embed keeps that shape — it
 * resolves the token to the Work's address via the same `/share/:token` endpoint, then
 * fetches the ordinary Work detail carrying the token, exactly as the full page does. What
 * differs is presentation (no chrome, player only), never access.
 *
 * It renders bare like `/site-gate`, outside every shell, so a site embedding it gets the
 * player and nothing else.
 */
import { consumptionModeFor, isTimePoolEligible } from "@anthers/shared/attention";
import { Link, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useRef, useState } from "react";
import { PublicAccessWall } from "../components/media/PublicAccessNotice";
import SharedWorkBanner from "../components/work/SharedWorkBanner";
import { pageHoldsTheMeter, WorkDeliverable, type WorkDetail } from "../components/work/WorkLayout";
import { useAttentionClaim } from "../lib/attention";
import { useMeteredBudget } from "../lib/public-access";
import { withShareToken } from "../lib/share-link";

export default function EmbedWorkPage() {
	const { token } = useParams<{ token: string }>();
	const [work, setWork] = useState<WorkDetail | null>(null);
	const [failed, setFailed] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!token) {
			setFailed(true);
			setLoading(false);
			return;
		}
		let canceled = false;
		(async () => {
			try {
				// Resolve the token to the Work's address — *where*, never *whether*. The same
				// endpoint the redirect page uses, and re-checking shareability at resolution
				// time exactly as the link does.
				const linkRes = await client.api.content.share[":token"].$get({ param: { token } });
				if (!linkRes.ok) {
					if (!canceled) setFailed(true);
					return;
				}
				const link = (await linkRes.json()) as { slug: string; publicId: number };
				// Then the Work's ordinary detail, carrying the token so the one resolver
				// decides access — the page never computes a gate itself.
				const workRes = await client.api.content.works[":id"].$get({
					param: { id: `${link.slug}-${link.publicId}` },
					query: { share: token },
				});
				if (!workRes.ok) {
					if (!canceled) setFailed(true);
					return;
				}
				const data = (await workRes.json()) as unknown as { work: WorkDetail };
				if (!canceled) setWork(data.work);
			} catch {
				if (!canceled) setFailed(true);
			} finally {
				if (!canceled) setLoading(false);
			}
		})();
		return () => {
			canceled = true;
		};
	}, [token]);

	// The presence claim for the media that have no player of their own — the same wiring
	// as the full Work page, gated on the deliverable being on screen. Playback-mode media
	// claim from inside their players instead.
	const deliverableRef = useRef<HTMLElement>(null);
	const presence = work ? consumptionModeFor(work.type) === "presence" : false;
	useAttentionClaim({
		creatorId: work?.creatorId ?? null,
		workId: work?.id ?? null,
		contentType: work?.type ?? "",
		active:
			!!work && presence && isTimePoolEligible(work.type) && (work.access?.canAccess ?? false),
		elementRef: presence ? deliverableRef : undefined,
	});

	// The relay's meter, for the playerless media — video and audio own their own.
	const meterBudget = useMeteredBudget();
	const playerless = work != null && pageHoldsTheMeter(work.type);
	const spentOnThis =
		playerless && (work?.publicAccess ?? false) && meterBudget != null && !meterBudget.allowed;

	if (loading) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<LoadingSpinner />
			</div>
		);
	}

	if (failed || !work) {
		return (
			<div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12 text-center">
				<h1 className="text-xl font-bold">This embed isn't available</h1>
				{/* A revoked or never-existed token read the same on purpose, as with the link. */}
				<p className="mt-3 text-sm text-base-content/70">
					It may have been turned off, or the work may no longer be open to everyone.
				</p>
				<Link to="/" className="btn btn-primary btn-sm mt-6 self-center">
					Go to Anthers
				</Link>
			</div>
		);
	}

	const canAccess = work.access?.canAccess ?? false;
	const jobStatus = work.transcoding?.status;
	const encoding = jobStatus != null && jobStatus !== "completed" && jobStatus !== "failed";

	return (
		<div className="mx-auto max-w-3xl p-3">
			{canAccess ? (
				<section ref={deliverableRef}>
					{spentOnThis ? (
						// The sharer's relay allowance is gone, so the server withheld the
						// deliverable — the reason is all there is to render.
						<PublicAccessWall budget={meterBudget} />
					) : encoding ? (
						<p className="py-12 text-center text-sm text-base-content/60">Processing…</p>
					) : (
						<WorkDeliverable work={work} shareToken={token ?? null} />
					)}
				</section>
			) : (
				// A share token only ever reaches universally-free work, so hitting this branch
				// means the Work stopped being shareable after the token was minted. There is
				// no gate to clear inside an embed — send the viewer to the full page instead.
				<div className="py-12 text-center">
					<p className="text-sm text-base-content/70">This work isn't open to embed right now.</p>
					<Link
						to={withShareToken(`/works/${work.slug}-${work.publicId}`, token ?? null)}
						className="btn btn-primary btn-sm mt-4"
					>
						Open on Anthers
					</Link>
				</div>
			)}

			{/* Who shared it, and the way to an account of their own — under the deliverable,
			    exactly as on the full page. */}
			{token && <SharedWorkBanner sharedBy={work.sharedBy ?? null} />}
		</div>
	);
}
