ALTER TABLE "projects" ADD COLUMN "works_sort_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "works_sort_direction" text DEFAULT 'asc' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "posts_sort_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "posts_sort_direction" text DEFAULT 'asc' NOT NULL;