CREATE TABLE "resource_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"component" text NOT NULL,
	"instance_size" text,
	"instance_count" integer,
	"cpu_pct" real,
	"memory_pct" real,
	"restart_count" integer,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_resource_snapshots_component_taken" ON "resource_snapshots" USING btree ("component","taken_at");