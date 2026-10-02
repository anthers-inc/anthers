CREATE TABLE "creator_transfer_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"transfer_id" integer NOT NULL,
	"credit_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer,
	"stripe_transfer_id" text NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"transferred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_transfers_stripe_transfer_id_unique" UNIQUE("stripe_transfer_id")
);
--> statement-breakpoint
ALTER TABLE "creator_transfer_credits" ADD CONSTRAINT "creator_transfer_credits_transfer_id_creator_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."creator_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_transfer_credits" ADD CONSTRAINT "creator_transfer_credits_credit_id_creator_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."creator_credits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_transfers" ADD CONSTRAINT "creator_transfers_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_transfer_credits_pair" ON "creator_transfer_credits" USING btree ("transfer_id","credit_id");--> statement-breakpoint
CREATE INDEX "idx_creator_transfer_credits_credit" ON "creator_transfer_credits" USING btree ("credit_id");--> statement-breakpoint
CREATE INDEX "idx_creator_transfers_creator" ON "creator_transfers" USING btree ("creator_id");