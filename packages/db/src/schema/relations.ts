// SPDX-License-Identifier: Apache-2.0
import { relations } from "drizzle-orm";
import { atprotoSessions, follows, userBlocks, userSessions, users } from "./auth.js";
import {
	comments,
	inlineImages,
	posts,
	projectItems,
	projectPosts,
	projects,
	reviews,
	userReadingPositions,
	workAssets,
	workBuildFiles,
	workBuilds,
	workCreditDecisions,
	workMediaVersions,
	workSaves,
	works,
	workTranscodingJobs,
} from "./content.js";
import { charitableLedger, purchases, stripeConnectAccounts } from "./payments.js";
import {
	attentionEvents,
	badgeArtProvenance,
	badges,
	nounBlocklist,
	nounSpend,
	poolDistributions,
	stripeCustomers,
	userBadges,
	userCycles,
	userPreferences,
} from "./subscriptions.js";

// ─── Auth ────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
	userSessions: many(userSessions),
	atprotoSession: one(atprotoSessions),

	// Follows (both directions)
	following: many(follows, { relationName: "follower" }),
	followers: many(follows, { relationName: "creator" }),

	// Blocks. Both directions are declared because enforcement reads both — a block is
	// stored directed so an unblock knows whose decision it was, but "can these two
	// meet?" is answered from either side.
	blocking: many(userBlocks, { relationName: "blocker" }),
	blockedBy: many(userBlocks, { relationName: "blocked" }),

	// Content
	works: many(works), // the creator's Catalog
	posts: many(posts),
	projects: many(projects), // Projects the creator owns
	inlineImages: many(inlineImages),
	comments: many(comments),
	reviews: many(reviews),

	// Payments
	stripeAccount: one(stripeConnectAccounts),
	purchases: many(purchases),

	// Accounts & economics
	billingAccount: one(stripeCustomers),
	userPreferences: one(userPreferences),
	userCycles: many(userCycles),
	attentionEventsAsUser: many(attentionEvents, { relationName: "attentionUser" }),
	attentionEventsAsCreator: many(attentionEvents, { relationName: "attentionCreator" }),
	userBadges: many(userBadges, { relationName: "badgeHolder" }),
	badges: many(badges), // the Badges this user issues as a creator
	poolDistributionsAsSubscriber: many(poolDistributions, { relationName: "poolSubscriber" }),
	poolDistributionsAsCreator: many(poolDistributions, { relationName: "poolCreator" }),

	// Integrations
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
	user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));

export const atprotoSessionsRelations = relations(atprotoSessions, ({ one }) => ({
	user: one(users, { fields: [atprotoSessions.userId], references: [users.id] }),
}));

export const followsRelations = relations(follows, ({ one }) => ({
	follower: one(users, {
		fields: [follows.followerId],
		references: [users.id],
		relationName: "follower",
	}),
	creator: one(users, {
		fields: [follows.creatorId],
		references: [users.id],
		relationName: "creator",
	}),
}));

export const userBlocksRelations = relations(userBlocks, ({ one }) => ({
	blocker: one(users, {
		fields: [userBlocks.blockerId],
		references: [users.id],
		relationName: "blocker",
	}),
	blocked: one(users, {
		fields: [userBlocks.blockedId],
		references: [users.id],
		relationName: "blocked",
	}),
}));

// ─── Content ─────────────────────────────────────────────────────────────────

// Posts — announcements. They embed Works by carrying their links in the body.
export const postsRelations = relations(posts, ({ one, many }) => ({
	creator: one(users, { fields: [posts.creatorId], references: [users.id] }),
	projectPosts: many(projectPosts), // Projects this post belongs to
	attentionEvents: many(attentionEvents),
}));

// Projects — they group Works and Posts.
// A project collects BOTH kinds, in separate ordered lists — a game project holds its
// builds and soundtrack (Works) alongside its devlogs and patch notes (Posts).
export const projectsRelations = relations(projects, ({ one, many }) => ({
	creator: one(users, { fields: [projects.creatorId], references: [users.id] }),
	thumbnailWork: one(works, { fields: [projects.thumbnailWorkId], references: [works.id] }),
	projectPosts: many(projectPosts),
	projectItems: many(projectItems),
}));

export const projectItemsRelations = relations(projectItems, ({ one }) => ({
	project: one(projects, { fields: [projectItems.projectId], references: [projects.id] }),
	work: one(works, { fields: [projectItems.workId], references: [works.id] }),
}));

export const projectPostsRelations = relations(projectPosts, ({ one }) => ({
	project: one(projects, { fields: [projectPosts.projectId], references: [projects.id] }),
	post: one(posts, { fields: [projectPosts.postId], references: [posts.id] }),
}));

// Works — the Catalog. Own their media, downloadable variants, transcodes and gates.
export const worksRelations = relations(works, ({ one, many }) => ({
	creator: one(users, { fields: [works.creatorId], references: [users.id] }),
	workAssets: many(workAssets),
	workBuilds: many(workBuilds),
	mediaVersions: many(workMediaVersions),
	saves: many(workSaves),
	workTranscodingJobs: many(workTranscodingJobs),
	projectItems: many(projectItems), // Projects this Work belongs to
	purchases: many(purchases),
	reviews: many(reviews),
	creditDecisions: many(workCreditDecisions),
}));

export const workAssetsRelations = relations(workAssets, ({ one }) => ({
	work: one(works, { fields: [workAssets.workId], references: [works.id] }),
}));

export const workBuildsRelations = relations(workBuilds, ({ one, many }) => ({
	work: one(works, { fields: [workBuilds.workId], references: [works.id] }),
	files: many(workBuildFiles),
}));

export const workMediaVersionsRelations = relations(workMediaVersions, ({ one }) => ({
	work: one(works, { fields: [workMediaVersions.workId], references: [works.id] }),
}));

export const workBuildFilesRelations = relations(workBuildFiles, ({ one }) => ({
	build: one(workBuilds, { fields: [workBuildFiles.buildId], references: [workBuilds.id] }),
}));

export const workSavesRelations = relations(workSaves, ({ one }) => ({
	user: one(users, { fields: [workSaves.userId], references: [users.id] }),
	work: one(works, { fields: [workSaves.workId], references: [works.id] }),
}));

export const userReadingPositionsRelations = relations(userReadingPositions, ({ one }) => ({
	user: one(users, { fields: [userReadingPositions.userId], references: [users.id] }),
	work: one(works, { fields: [userReadingPositions.workId], references: [works.id] }),
}));

export const workTranscodingJobsRelations = relations(workTranscodingJobs, ({ one }) => ({
	work: one(works, { fields: [workTranscodingJobs.workId], references: [works.id] }),
}));

export const inlineImagesRelations = relations(inlineImages, ({ one }) => ({
	creator: one(users, { fields: [inlineImages.creatorId], references: [users.id] }),
}));

// No `subject` relation on comments: the subject is polymorphic, so there is nothing for
// the relational API to point at. Every read joins explicitly, as moderation's do.
export const commentsRelations = relations(comments, ({ one }) => ({
	user: one(users, { fields: [comments.userId], references: [users.id] }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
	user: one(users, { fields: [reviews.userId], references: [users.id] }),
	work: one(works, { fields: [reviews.workId], references: [works.id] }),
}));

// ─── Payments ────────────────────────────────────────────────────────────────

export const stripeConnectAccountsRelations = relations(stripeConnectAccounts, ({ one }) => ({
	user: one(users, { fields: [stripeConnectAccounts.userId], references: [users.id] }),
}));

export const purchasesRelations = relations(purchases, ({ one, many }) => ({
	buyer: one(users, { fields: [purchases.buyerId], references: [users.id] }),
	work: one(works, { fields: [purchases.workId], references: [works.id] }),
	crfLedgerEntries: many(charitableLedger),
}));

export const charitableLedgerRelations = relations(charitableLedger, ({ one }) => ({
	purchase: one(purchases, { fields: [charitableLedger.purchaseId], references: [purchases.id] }),
}));

// ─── Subscriptions ───────────────────────────────────────────────────────────

export const stripeCustomersRelations = relations(stripeCustomers, ({ one }) => ({
	user: one(users, { fields: [stripeCustomers.userId], references: [users.id] }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
	user: one(users, { fields: [userPreferences.userId], references: [users.id] }),
}));

export const userCyclesRelations = relations(userCycles, ({ one }) => ({
	user: one(users, { fields: [userCycles.userId], references: [users.id] }),
}));

export const attentionEventsRelations = relations(attentionEvents, ({ one }) => ({
	user: one(users, {
		fields: [attentionEvents.userId],
		references: [users.id],
		relationName: "attentionUser",
	}),
	creator: one(users, {
		fields: [attentionEvents.creatorId],
		references: [users.id],
		relationName: "attentionCreator",
	}),
	work: one(works, { fields: [attentionEvents.workId], references: [works.id] }),
}));

export const userBadgesRelations = relations(userBadges, ({ one }) => ({
	user: one(users, {
		fields: [userBadges.userId],
		references: [users.id],
		relationName: "badgeHolder",
	}),
	badge: one(badges, { fields: [userBadges.badgeId], references: [badges.id] }),
}));

export const poolDistributionsRelations = relations(poolDistributions, ({ one }) => ({
	subscriber: one(users, {
		fields: [poolDistributions.subscriberId],
		references: [users.id],
		relationName: "poolSubscriber",
	}),
	creator: one(users, {
		fields: [poolDistributions.creatorId],
		references: [users.id],
		relationName: "poolCreator",
	}),
}));

export const badgesRelations = relations(badges, ({ one, many }) => ({
	owner: one(users, { fields: [badges.creatorId], references: [users.id] }),
	heldBy: many(userBadges),
}));

export const badgeArtProvenanceRelations = relations(badgeArtProvenance, ({ one }) => ({
	badge: one(badges, { fields: [badgeArtProvenance.badgeId], references: [badges.id] }),
}));

export const nounSpendRelations = relations(nounSpend, ({ one }) => ({
	creator: one(users, { fields: [nounSpend.creatorId], references: [users.id] }),
}));

export const nounBlocklistRelations = relations(nounBlocklist, ({ one }) => ({
	addedByAdmin: one(users, { fields: [nounBlocklist.addedBy], references: [users.id] }),
}));
