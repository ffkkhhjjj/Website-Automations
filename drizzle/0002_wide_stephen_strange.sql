CREATE TYPE "public"."rejection_reason" AS ENUM('INACTIVE_BUSINESS', 'NO_CONTACT_ROUTE', 'OUTSIDE_ICP', 'EXCELLENT_WEBSITE', 'LOW_OPPORTUNITY', 'OPT_OUT', 'DO_NOT_CONTACT_REQUEST', 'BAD_DATA', 'DUPLICATE', 'OTHER');--> statement-breakpoint
CREATE TABLE "rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"reason" "rejection_reason" NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rejections_business_id" ON "rejections" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_rejections_reason" ON "rejections" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "idx_rejections_created_at" ON "rejections" USING btree ("created_at");