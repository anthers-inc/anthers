ALTER TABLE "works" DROP CONSTRAINT "works_creator_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "creator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;