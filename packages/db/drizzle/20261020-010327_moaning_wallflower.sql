UPDATE "projects" SET "description" = "short_description" WHERE "description" = '' AND "short_description" <> '';--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "short_description";
