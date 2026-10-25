-- The switch says what interface a person is owed, never that they are a creator, and the old
-- name was the bug: discovery, creator search and the post gate all read `is_creator` as though
-- it answered "is a creator". A rename keeps every account's answer — somebody who turned the
-- Studio on must not be handed back to a default because the column moved.
ALTER TABLE "users" RENAME COLUMN "is_creator" TO "creator_mode";
