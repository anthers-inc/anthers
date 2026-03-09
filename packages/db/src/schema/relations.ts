import { relations } from "drizzle-orm";
import { users, sessions, verificationTokens } from "./auth.js";
import { projects } from "./content.js";

export const usersRelations = relations(users, ({ many }) => ({
	sessions: many(sessions),
	verificationTokens: many(verificationTokens),
	projects: many(projects),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const verificationTokensRelations = relations(verificationTokens, ({ one }) => ({
	user: one(users, { fields: [verificationTokens.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one }) => ({
	creator: one(users, { fields: [projects.creatorId], references: [users.id] }),
}));
