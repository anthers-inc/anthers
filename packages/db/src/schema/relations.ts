// SPDX-License-Identifier: AGPL-3.0-or-later
import { relations } from "drizzle-orm";
import { atprotoSessions, follows, sessions, users, verificationTokens } from "./auth.js";
import {
	assets,
	bookmarks,
	comments,
	inlineImages,
	postContents,
	posts,
	projectPosts,
	projects,
	ratings,
	transcodingJobs,
} from "./content.js";
import {
	crossPublishResults,
	externalMetricSnapshots,
	platformConnections,
} from "./integrations.js";
import { gameJams, jamEntries, jamVotes } from "./jams.js";
import { crfLedger, crfSubsidies, purchases, stripeAccounts } from "./payments.js";
import {
	attentionEvents,
	boostAllocations,
	creatorGates,
	poolDistributions,
	subscriptions,
} from "./subscriptions.js";

// ─── Auth ────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
	sessions: many(sessions),
	verificationTokens: many(verificationTokens),
	atprotoSession: one(atprotoSessions),

	// Follows (both directions)
	following: many(follows, { relationName: "follower" }),
	followers: many(follows, { relationName: "creator" }),

	// Content
	posts: many(posts),
	projects: many(projects), // collections the creator owns
	inlineImages: many(inlineImages),
	comments: many(comments),
	ratings: many(ratings),
	bookmarks: many(bookmarks, { relationName: "bookmarkOwner" }),
	bookmarkedBy: many(bookmarks, { relationName: "bookmarkCreator" }),

	// Payments
	stripeAccount: one(stripeAccounts),
	purchases: many(purchases),
	crfSubsidies: many(crfSubsidies),

	// Subscriptions
	subscription: one(subscriptions),
	attentionEventsAsUser: many(attentionEvents, { relationName: "attentionUser" }),
	attentionEventsAsCreator: many(attentionEvents, { relationName: "attentionCreator" }),
	boostAllocationsAsUser: many(boostAllocations, { relationName: "boostUser" }),
	boostAllocationsAsCreator: many(boostAllocations, { relationName: "boostCreator" }),
	poolDistributionsAsSubscriber: many(poolDistributions, { relationName: "poolSubscriber" }),
	poolDistributionsAsCreator: many(poolDistributions, { relationName: "poolCreator" }),
	creatorGates: many(creatorGates),

	// Integrations
	platformConnections: many(platformConnections),
	crossPublishResults: many(crossPublishResults),

	// Jams
	gameJams: many(gameJams),
	jamEntries: many(jamEntries),
	jamVotes: many(jamVotes),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const verificationTokensRelations = relations(verificationTokens, ({ one }) => ({
	user: one(users, { fields: [verificationTokens.userId], references: [users.id] }),
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

// ─── Content ─────────────────────────────────────────────────────────────────

// Posts — the universal content unit.
export const postsRelations = relations(posts, ({ one, many }) => ({
	creator: one(users, { fields: [posts.creatorId], references: [users.id] }),
	projectPosts: many(projectPosts), // collections this post belongs to
	contents: many(postContents),
	comments: many(comments),
	ratings: many(ratings),
	purchases: many(purchases),
	attentionEvents: many(attentionEvents),
	crossPublishResults: many(crossPublishResults),
	jamEntries: many(jamEntries),
}));

// Projects — collections that group posts.
export const projectsRelations = relations(projects, ({ one, many }) => ({
	creator: one(users, { fields: [projects.creatorId], references: [users.id] }),
	projectPosts: many(projectPosts),
	bookmarks: many(bookmarks),
}));

export const projectPostsRelations = relations(projectPosts, ({ one }) => ({
	project: one(projects, { fields: [projectPosts.projectId], references: [projects.id] }),
	post: one(posts, { fields: [projectPosts.postId], references: [posts.id] }),
}));

export const postContentsRelations = relations(postContents, ({ one, many }) => ({
	post: one(posts, { fields: [postContents.postId], references: [posts.id] }),
	assets: many(assets),
	transcodingJobs: many(transcodingJobs),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
	content: one(postContents, { fields: [assets.contentId], references: [postContents.id] }),
}));

export const transcodingJobsRelations = relations(transcodingJobs, ({ one }) => ({
	content: one(postContents, {
		fields: [transcodingJobs.contentId],
		references: [postContents.id],
	}),
}));

export const inlineImagesRelations = relations(inlineImages, ({ one }) => ({
	creator: one(users, { fields: [inlineImages.creatorId], references: [users.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
	user: one(users, { fields: [comments.userId], references: [users.id] }),
	post: one(posts, { fields: [comments.postId], references: [posts.id] }),
}));

export const ratingsRelations = relations(ratings, ({ one }) => ({
	user: one(users, { fields: [ratings.userId], references: [users.id] }),
	post: one(posts, { fields: [ratings.postId], references: [posts.id] }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
	user: one(users, {
		fields: [bookmarks.userId],
		references: [users.id],
		relationName: "bookmarkOwner",
	}),
	post: one(posts, { fields: [bookmarks.postId], references: [posts.id] }),
	project: one(projects, { fields: [bookmarks.projectId], references: [projects.id] }),
	creator: one(users, {
		fields: [bookmarks.creatorId],
		references: [users.id],
		relationName: "bookmarkCreator",
	}),
}));

// ─── Payments ────────────────────────────────────────────────────────────────

export const stripeAccountsRelations = relations(stripeAccounts, ({ one }) => ({
	user: one(users, { fields: [stripeAccounts.userId], references: [users.id] }),
}));

export const purchasesRelations = relations(purchases, ({ one, many }) => ({
	buyer: one(users, { fields: [purchases.buyerId], references: [users.id] }),
	post: one(posts, { fields: [purchases.postId], references: [posts.id] }),
	crfLedgerEntries: many(crfLedger),
}));

export const crfLedgerRelations = relations(crfLedger, ({ one }) => ({
	purchase: one(purchases, { fields: [crfLedger.purchaseId], references: [purchases.id] }),
}));

export const crfSubsidiesRelations = relations(crfSubsidies, ({ one }) => ({
	creator: one(users, { fields: [crfSubsidies.creatorId], references: [users.id] }),
}));

// ─── Subscriptions ───────────────────────────────────────────────────────────

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
	user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
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
	post: one(posts, { fields: [attentionEvents.postId], references: [posts.id] }),
}));

export const boostAllocationsRelations = relations(boostAllocations, ({ one }) => ({
	user: one(users, {
		fields: [boostAllocations.userId],
		references: [users.id],
		relationName: "boostUser",
	}),
	creator: one(users, {
		fields: [boostAllocations.creatorId],
		references: [users.id],
		relationName: "boostCreator",
	}),
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

export const creatorGatesRelations = relations(creatorGates, ({ one }) => ({
	creator: one(users, { fields: [creatorGates.creatorId], references: [users.id] }),
}));

// ─── Integrations ────────────────────────────────────────────────────────────

export const platformConnectionsRelations = relations(platformConnections, ({ one }) => ({
	user: one(users, { fields: [platformConnections.userId], references: [users.id] }),
}));

export const crossPublishResultsRelations = relations(crossPublishResults, ({ one, many }) => ({
	user: one(users, { fields: [crossPublishResults.userId], references: [users.id] }),
	post: one(posts, { fields: [crossPublishResults.postId], references: [posts.id] }),
	metricSnapshots: many(externalMetricSnapshots),
}));

export const externalMetricSnapshotsRelations = relations(externalMetricSnapshots, ({ one }) => ({
	crossPublishResult: one(crossPublishResults, {
		fields: [externalMetricSnapshots.crossPublishId],
		references: [crossPublishResults.id],
	}),
}));

// ─── Jams ────────────────────────────────────────────────────────────────────

export const gameJamsRelations = relations(gameJams, ({ one, many }) => ({
	creator: one(users, { fields: [gameJams.creatorId], references: [users.id] }),
	entries: many(jamEntries),
}));

export const jamEntriesRelations = relations(jamEntries, ({ one, many }) => ({
	jam: one(gameJams, { fields: [jamEntries.jamId], references: [gameJams.id] }),
	post: one(posts, { fields: [jamEntries.postId], references: [posts.id] }),
	submittedBy: one(users, { fields: [jamEntries.submittedById], references: [users.id] }),
	votes: many(jamVotes),
}));

export const jamVotesRelations = relations(jamVotes, ({ one }) => ({
	entry: one(jamEntries, { fields: [jamVotes.entryId], references: [jamEntries.id] }),
	user: one(users, { fields: [jamVotes.userId], references: [users.id] }),
}));
