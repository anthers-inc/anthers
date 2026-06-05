/**
 * External metrics fetch job: poll YouTube/itch.io for cross-published content metrics.
 *
 * Ported from _legacy/backend/integrations/tasks.py fetch_external_metrics()
 *
 * Runs every 6 hours via the worker's cron schedule.
 */

import { db } from "@anthers/db";
import {
	crossPublishResults,
	externalMetricSnapshots,
	platformConnections,
} from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";

interface Metrics {
	views: number;
	likes: number;
	comments: number;
}

async function fetchYoutubeMetrics(
	crossPub: typeof crossPublishResults.$inferSelect,
	connection: typeof platformConnections.$inferSelect,
): Promise<Metrics | null> {
	if (!crossPub.externalId) return null;

	const accessToken = connection.accessToken;

	// Refresh if expired
	if (connection.tokenExpiresAt && connection.tokenExpiresAt < new Date()) {
		// TODO: Implement YouTube OAuth token refresh
		console.warn("YouTube token expired, skipping metrics fetch");
		return null;
	}

	try {
		const url = new URL("https://www.googleapis.com/youtube/v3/videos");
		url.searchParams.set("part", "statistics");
		url.searchParams.set("id", crossPub.externalId);

		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(15000),
		});

		if (!res.ok) return null;

		const data = await res.json();
		const items = data.items ?? [];
		if (items.length === 0) return null;

		const stats = items[0].statistics ?? {};
		return {
			views: Number.parseInt(stats.viewCount ?? "0", 10),
			likes: Number.parseInt(stats.likeCount ?? "0", 10),
			comments: Number.parseInt(stats.commentCount ?? "0", 10),
		};
	} catch (error) {
		console.error("YouTube metrics fetch failed:", error);
		return null;
	}
}

async function fetchItchioMetrics(
	crossPub: typeof crossPublishResults.$inferSelect,
	connection: typeof platformConnections.$inferSelect,
): Promise<Metrics | null> {
	if (!crossPub.externalId) return null;

	try {
		const res = await fetch(`https://itch.io/api/1/key/game/${crossPub.externalId}`, {
			headers: {
				Authorization: `Bearer ${connection.apiKey ?? ""}`,
			},
			signal: AbortSignal.timeout(15000),
		});

		if (!res.ok) return null;

		const data = await res.json();
		const game = data.game ?? {};
		return {
			views: game.views_count ?? 0,
			likes: 0,
			comments: 0,
		};
	} catch (error) {
		console.error("itch.io metrics fetch failed:", error);
		return null;
	}
}

const metricsFetchers: Record<
	string,
	(
		cp: typeof crossPublishResults.$inferSelect,
		conn: typeof platformConnections.$inferSelect,
	) => Promise<Metrics | null>
> = {
	youtube: fetchYoutubeMetrics,
	itchio: fetchItchioMetrics,
};

export async function fetchExternalMetrics() {
	const published = await db
		.select()
		.from(crossPublishResults)
		.where(eq(crossPublishResults.status, "published"));

	const now = new Date();
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

	for (const crossPub of published) {
		const [connection] = await db
			.select()
			.from(platformConnections)
			.where(
				and(
					eq(platformConnections.userId, crossPub.userId),
					eq(platformConnections.platform, crossPub.platform),
					eq(platformConnections.isActive, true),
				),
			)
			.limit(1);

		if (!connection) continue;

		const fetcher = metricsFetchers[crossPub.platform];
		if (!fetcher) continue;

		const metrics = await fetcher(crossPub, connection);
		if (!metrics) continue;

		await db
			.insert(externalMetricSnapshots)
			.values({
				crossPublishId: crossPub.id,
				snapshotDate: today,
				views: metrics.views,
				likes: metrics.likes,
				comments: metrics.comments,
			})
			.onConflictDoUpdate({
				target: [externalMetricSnapshots.crossPublishId, externalMetricSnapshots.snapshotDate],
				set: {
					views: metrics.views,
					likes: metrics.likes,
					comments: metrics.comments,
				},
			});
	}

	console.log(`Fetched external metrics for ${published.length} cross-published items`);
}
