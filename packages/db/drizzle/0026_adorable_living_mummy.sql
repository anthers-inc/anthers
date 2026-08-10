ALTER TABLE "assets" ADD COLUMN "p2p_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "p2p_manifest_built_at" timestamp with time zone;