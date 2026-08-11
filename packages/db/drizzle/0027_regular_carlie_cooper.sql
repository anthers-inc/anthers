CREATE TABLE "p2p_peers" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"work_id" integer NOT NULL,
	"url" text NOT NULL,
	"user_id" integer NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "p2p_peers" ADD CONSTRAINT "p2p_peers_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_peers" ADD CONSTRAINT "p2p_peers_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_peers" ADD CONSTRAINT "p2p_peers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_p2p_peers_asset_url" ON "p2p_peers" USING btree ("asset_id","url");--> statement-breakpoint
CREATE INDEX "idx_p2p_peers_asset_live" ON "p2p_peers" USING btree ("asset_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_p2p_peers_user_asset" ON "p2p_peers" USING btree ("user_id","asset_id");