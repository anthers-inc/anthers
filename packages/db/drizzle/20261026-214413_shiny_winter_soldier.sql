ALTER TABLE "hosted_accounts" ALTER COLUMN "sealed_password" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "basket_items" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "basket_items" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "shipping_amount" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "handling_business_days" integer;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "stock_released_at" timestamp with time zone;