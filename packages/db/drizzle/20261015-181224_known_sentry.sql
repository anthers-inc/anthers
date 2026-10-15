CREATE TABLE "status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"day" text NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"degraded" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_incident_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"severity" text NOT NULL,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"severity" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "status_incident_updates" ADD CONSTRAINT "status_incident_updates_incident_id_status_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."status_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_status_history_component_day" ON "status_history" USING btree ("component","day");--> statement-breakpoint
CREATE INDEX "idx_status_history_day" ON "status_history" USING btree ("day");--> statement-breakpoint
CREATE INDEX "idx_status_incident_updates_incident_at" ON "status_incident_updates" USING btree ("incident_id","at");--> statement-breakpoint
CREATE INDEX "idx_status_incidents_component_opened" ON "status_incidents" USING btree ("component","opened_at");--> statement-breakpoint
CREATE INDEX "idx_status_incidents_resolved" ON "status_incidents" USING btree ("resolved_at");