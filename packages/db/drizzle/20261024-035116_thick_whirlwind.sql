-- The account's shortcut map now carries the player's keys beside the search bar's, so its
-- old name described half of what it holds. A rename keeps every stored pair: an account
-- that rebound Search or Filter must not meet the defaults again because the column moved.
ALTER TABLE "user_preferences" RENAME COLUMN "search_shortcuts" TO "keyboard_shortcuts";
