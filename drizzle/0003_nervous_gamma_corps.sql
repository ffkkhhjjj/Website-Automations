CREATE TYPE "public"."discovery_job_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED');--> statement-breakpoint
CREATE TABLE "discovery_job_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"business_name" text,
	"message" text NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"category" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"industry" text NOT NULL,
	"state" text NOT NULL,
	"city" text,
	"provider" text NOT NULL,
	"status" "discovery_job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"params" jsonb,
	"progress" jsonb DEFAULT '{"records_fetched":0,"ingested":0,"duplicates_skipped":0,"invalid_skipped":0,"errors":0}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_job_errors" ADD CONSTRAINT "discovery_job_errors_job_id_discovery_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."discovery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_discovery_job_errors_job_id" ON "discovery_job_errors" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_discovery_jobs_status" ON "discovery_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_discovery_jobs_created_at" ON "discovery_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_discovery_jobs_industry_state" ON "discovery_jobs" USING btree ("industry","state");