/**
 * Cross-publish job: publish content to external platforms.
 *
 * Ported from _legacy/backend/integrations/tasks.py cross_publish_to_platform()
 */

import { eq, and } from "drizzle-orm";
import { db } from "@anthers/db";
import {
	crossPublishResults,
	platformConnections,
} from "@anthers/db/schema";

export interface CrossPublishData {
	crossPublishId: number;
}

/**
 * Platform-specific publisher functions.
 * Each returns [externalId, externalUrl] on success.
 *
 * TODO: Implement actual platform API calls in Phase 5/6
 */
async function publishToYoutube(
	_crossPublish: typeof crossPublishResults.$inferSelect,
	_connection: typeof platformConnections.$inferSelect,
): Promise<[string, string]> {
	throw new Error("YouTube publishing not yet implemented");
}

async function publishToItchio(
	_crossPublish: typeof crossPublishResults.$inferSelect,
	_connection: typeof platformConnections.$inferSelect,
): Promise<[string, string]> {
	throw new Error("itch.io publishing not yet implemented");
}

async function publishToSubstack(
	_crossPublish: typeof crossPublishResults.$inferSelect,
	_connection: typeof platformConnections.$inferSelect,
): Promise<[string, string]> {
	throw new Error("Substack publishing not yet implemented");
}

const publishers: Record<
	string,
	(
		cp: typeof crossPublishResults.$inferSelect,
		conn: typeof platformConnections.$inferSelect,
	) => Promise<[string, string]>
> = {
	youtube: publishToYoutube,
	itchio: publishToItchio,
	substack: publishToSubstack,
};

export async function crossPublish(data: CrossPublishData) {
	const [crossPub] = await db
		.select()
		.from(crossPublishResults)
		.where(eq(crossPublishResults.id, data.crossPublishId))
		.limit(1);

	if (!crossPub) {
		console.error(
			`CrossPublishResult ${data.crossPublishId} not found`,
		);
		return;
	}

	// Get platform connection
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

	if (!connection) {
		await db
			.update(crossPublishResults)
			.set({
				status: "failed",
				errorMessage: `No active ${crossPub.platform} connection found.`,
			})
			.where(eq(crossPublishResults.id, crossPub.id));
		return;
	}

	const publisher = publishers[crossPub.platform];
	if (!publisher) {
		await db
			.update(crossPublishResults)
			.set({
				status: "failed",
				errorMessage: `No publisher available for ${crossPub.platform}.`,
			})
			.where(eq(crossPublishResults.id, crossPub.id));
		return;
	}

	try {
		const [externalId, externalUrl] = await publisher(crossPub, connection);
		await db
			.update(crossPublishResults)
			.set({
				status: "published",
				externalId,
				externalUrl,
				publishedAt: new Date(),
				errorMessage: null,
			})
			.where(eq(crossPublishResults.id, crossPub.id));

		console.log(
			`Cross-published to ${crossPub.platform}: ${externalUrl}`,
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error);
		await db
			.update(crossPublishResults)
			.set({
				status: "failed",
				errorMessage: message.slice(0, 1000),
			})
			.where(eq(crossPublishResults.id, crossPub.id));
		throw error; // queue will retry
	}
}
