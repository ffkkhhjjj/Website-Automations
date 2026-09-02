CREATE TYPE "public"."audit_actor_type" AS ENUM('SYSTEM', 'USER', 'API', 'JOB');--> statement-breakpoint
CREATE TYPE "public"."business_operational_status" AS ENUM('OPERATIONAL', 'CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('ACTIVE', 'INVALID', 'SUPPRESSED');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('OPEN', 'HANDLED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('ACTIVE', 'PAST_DUE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."demo_status" AS ENUM('GENERATING', 'READY', 'QA_FAILED', 'DEPLOYED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('AVAILABLE', 'REGISTERED', 'IN_USE', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."exception_priority" AS ENUM('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."lead_classification" AS ENUM('HIGH_PRIORITY', 'SECONDARY', 'REVIEW', 'REJECT');--> statement-breakpoint
CREATE TYPE "public"."lead_lifecycle_state" AS ENUM('DISCOVERED', 'ENRICHING', 'ENRICHED', 'ANALYZING', 'ANALYZED', 'QUALIFIED', 'REJECTED', 'DEMO_GENERATING', 'DEMO_READY', 'OUTREACH_PENDING', 'CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2', 'RESPONDED', 'NURTURE', 'INTERESTED', 'HOT', 'SALES_HANDOFF', 'WON', 'LOST', 'DO_NOT_CONTACT', 'CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('PENDING', 'SENT', 'BOUNCED', 'COMPLAINED', 'OPENED', 'CLICKED', 'REPLIED', 'OPTED_OUT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('PENDING', 'SEND_REQUESTED', 'REQUESTED', 'COMPLETE');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('OPEN', 'WON', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."production_website_status" AS ENUM('ONBOARDING_COMPLETE', 'CONTENT_GENERATION', 'WEBSITE_GENERATION', 'QA', 'CUSTOMER_REVIEW', 'DEPLOYMENT', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('INTERESTED', 'NEEDS_INFO', 'NOT_INTERESTED', 'OPT_OUT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."scoring_type" AS ENUM('WEBSITE_QUALITY', 'BUSINESS_OPPORTUNITY', 'LEAD_PRIORITY');--> statement-breakpoint
CREATE TYPE "public"."subscription_interval" AS ENUM('MONTH', 'YEAR');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."template_type" AS ENUM('DEMO', 'PRODUCTION_WEB');--> statement-breakpoint
CREATE TYPE "public"."website_classification" AS ENUM('EXCELLENT', 'GOOD', 'AVERAGE', 'WEAK', 'VERY_WEAK', 'NO_WEBSITE');--> statement-breakpoint
CREATE TYPE "public"."website_status" AS ENUM('NO_WEBSITE', 'DISCOVERED', 'SCRAPED', 'ANALYZED', 'CRAWL_FAILED');--> statement-breakpoint
CREATE TYPE "public"."website_version_status" AS ENUM('DRAFT', 'QA', 'DEPLOYED', 'ROLLED_BACK');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"source" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" text NOT NULL,
	"industry" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"zip" text,
	"phone" text,
	"email" text,
	"website_url" text,
	"source" text NOT NULL,
	"source_url" text,
	"rating" numeric(2, 1),
	"review_count" integer,
	"business_description" text,
	"services" jsonb,
	"service_area" jsonb,
	"hours" jsonb,
	"business_status" "business_operational_status" DEFAULT 'UNKNOWN',
	"decision_maker_name" text,
	"decision_maker_role" text,
	"contactability_score" integer,
	"provenance" jsonb,
	"lifecycle_state" "lead_lifecycle_state" DEFAULT 'DISCOVERED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_businesses_contactability" CHECK ("businesses"."contactability_score" BETWEEN 0 AND 100 OR "businesses"."contactability_score" IS NULL),
	CONSTRAINT "chk_businesses_rating" CHECK ("businesses"."rating" BETWEEN 0 AND 5 OR "businesses"."rating" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"phone" text,
	"source" text,
	"verified_at" timestamp with time zone,
	"contactability_score" integer,
	"status" "contact_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_contacts_contactability" CHECK ("contacts"."contactability_score" BETWEEN 0 AND 100 OR "contacts"."contactability_score" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"classification" "reply_classification",
	"classification_confidence" numeric(4, 3),
	"body" text NOT NULL,
	"received_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_conversation_messages_conf" CHECK ("conversation_messages"."classification_confidence" BETWEEN 0 AND 1 OR "conversation_messages"."classification_confidence" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"status" "conversation_status" DEFAULT 'OPEN' NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_onboarding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "onboarding_status" DEFAULT 'PENDING' NOT NULL,
	"requested_fields" jsonb,
	"collected_fields" jsonb,
	"onboarding_form_url" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_customer_onboarding_customer_id" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"status" "customer_status" DEFAULT 'ACTIVE' NOT NULL,
	"billing_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_customers_business_id" UNIQUE("business_id")
);
--> statement-breakpoint
CREATE TABLE "demos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"template_id" uuid,
	"status" "demo_status" DEFAULT 'GENERATING' NOT NULL,
	"demo_url" text,
	"design_config" jsonb,
	"content_payload" jsonb,
	"version" integer DEFAULT 1,
	"qa_results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"name" text NOT NULL,
	"status" "domain_status" DEFAULT 'AVAILABLE' NOT NULL,
	"registrar_ref" text,
	"dns_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_domains_name" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"priority" "exception_priority" NOT NULL,
	"category" text NOT NULL,
	"status" "exception_status" DEFAULT 'OPEN' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outreach_message_id" uuid NOT NULL,
	"sequence_step" integer,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"status" "followup_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"website_quality_score" integer,
	"business_opportunity_score" integer,
	"market_fit_score" numeric(5, 2),
	"lead_priority_score" numeric(5, 2),
	"classification" "lead_classification",
	"formula_fields" jsonb,
	"scoring_version" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_lead_scores_wsq" CHECK ("lead_scores"."website_quality_score" BETWEEN 0 AND 100 OR "lead_scores"."website_quality_score" IS NULL),
	CONSTRAINT "chk_lead_scores_bos" CHECK ("lead_scores"."business_opportunity_score" BETWEEN 0 AND 100 OR "lead_scores"."business_opportunity_score" IS NULL),
	CONSTRAINT "chk_lead_scores_market_fit" CHECK ("lead_scores"."market_fit_score" BETWEEN 0 AND 100 OR "lead_scores"."market_fit_score" IS NULL),
	CONSTRAINT "chk_lead_scores_priority" CHECK ("lead_scores"."lead_priority_score" BETWEEN 0 AND 100 OR "lead_scores"."lead_priority_score" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "lead_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"from_state" "lead_lifecycle_state",
	"to_state" "lead_lifecycle_state" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_date" date NOT NULL,
	"metric_name" text NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"dimension" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dimension_key" text GENERATED ALWAYS AS ((dimension)::text) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_metrics_date_name_dim" UNIQUE("metric_date","metric_name","dimension_key")
);
--> statement-breakpoint
CREATE TABLE "outreach_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"audience_query" jsonb,
	"email_template_id" uuid,
	"daily_limit" integer,
	"start_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_outreach_campaigns_daily_limit" CHECK ("outreach_campaigns"."daily_limit" > 0 OR "outreach_campaigns"."daily_limit" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "outreach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"campaign_id" uuid,
	"contact_id" uuid,
	"status" "message_status" DEFAULT 'PENDING' NOT NULL,
	"subject" text,
	"body" text,
	"sent_at" timestamp with time zone,
	"message_id_external" text,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"subscription_id" uuid,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"external_ref" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_payments_external_ref" UNIQUE("external_ref"),
	CONSTRAINT "chk_payments_amount" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "production_websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "production_website_status" DEFAULT 'ONBOARDING_COMPLETE' NOT NULL,
	"domain_id" uuid,
	"version" integer DEFAULT 1,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "opportunity_status" DEFAULT 'OPEN' NOT NULL,
	"source_lead_id" uuid,
	"demo_url" text,
	"value_estimate_cents" integer,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"score_type" "scoring_type" NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_scoring_versions_type_version" UNIQUE("score_type","version")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"status" "subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"interval" "subscription_interval" DEFAULT 'MONTH' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_subscriptions_amount" CHECK ("subscriptions"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"is_feature_flag" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_system_settings_type" CHECK ("system_settings"."type" IN ('string', 'number', 'boolean', 'json', 'array'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" "task_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "template_type" NOT NULL,
	"name" text NOT NULL,
	"template_schema" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_templates_type_name_version" UNIQUE("type","name","version")
);
--> statement-breakpoint
CREATE TABLE "website_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"website_quality_score" integer,
	"classification" "website_classification" NOT NULL,
	"category_scores" jsonb,
	"test_results" jsonb,
	"evidence" jsonb,
	"critical_failures" jsonb,
	"analysis_version" uuid,
	"analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_website_analyses_score" CHECK ("website_analyses"."website_quality_score" BETWEEN 0 AND 100 OR "website_analyses"."website_quality_score" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "website_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_website_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "website_version_status" DEFAULT 'DRAFT' NOT NULL,
	"change_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_website_versions_site_number" UNIQUE("production_website_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"url" text NOT NULL,
	"status" "website_status" DEFAULT 'DISCOVERED' NOT NULL,
	"http_status" integer,
	"domain" text,
	"discovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "u_websites_url" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_onboarding" ADD CONSTRAINT "customer_onboarding_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demos" ADD CONSTRAINT "demos_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demos" ADD CONSTRAINT "demos_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_outreach_message_id_outreach_messages_id_fk" FOREIGN KEY ("outreach_message_id") REFERENCES "public"."outreach_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_scoring_version_scoring_versions_id_fk" FOREIGN KEY ("scoring_version") REFERENCES "public"."scoring_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_state_history" ADD CONSTRAINT "lead_state_history_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_campaigns" ADD CONSTRAINT "outreach_campaigns_email_template_id_templates_id_fk" FOREIGN KEY ("email_template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_campaign_id_outreach_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."outreach_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_websites" ADD CONSTRAINT "production_websites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_websites" ADD CONSTRAINT "production_websites_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_source_lead_id_businesses_id_fk" FOREIGN KEY ("source_lead_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_analyses" ADD CONSTRAINT "website_analyses_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_analyses" ADD CONSTRAINT "website_analyses_analysis_version_scoring_versions_id_fk" FOREIGN KEY ("analysis_version") REFERENCES "public"."scoring_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_versions" ADD CONSTRAINT "website_versions_production_website_id_production_websites_id_fk" FOREIGN KEY ("production_website_id") REFERENCES "public"."production_websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_logs_entity" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_businesses_lifecycle_state" ON "businesses" USING btree ("lifecycle_state");--> statement-breakpoint
CREATE INDEX "idx_businesses_state_city" ON "businesses" USING btree ("state","city");--> statement-breakpoint
CREATE INDEX "idx_businesses_city_state_zip" ON "businesses" USING btree ("city","state","zip");--> statement-breakpoint
CREATE INDEX "idx_businesses_source" ON "businesses" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_businesses_industry" ON "businesses" USING btree ("industry");--> statement-breakpoint
CREATE INDEX "idx_businesses_zip" ON "businesses" USING btree ("zip");--> statement-breakpoint
CREATE INDEX "idx_contacts_business_id" ON "contacts" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_email" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_contacts_status" ON "contacts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_conversation_id" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_business_id" ON "conversations" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_status" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_customer_onboarding_status" ON "customer_onboarding" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_demos_business_id" ON "demos" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_demos_status" ON "demos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_demos_template_id" ON "demos" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_domains_customer_id" ON "domains" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_domains_status" ON "domains" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_exceptions_status_priority" ON "exceptions" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "idx_exceptions_entity" ON "exceptions" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_exceptions_first_seen_at" ON "exceptions" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "idx_followups_outreach_message_id" ON "followups" USING btree ("outreach_message_id");--> statement-breakpoint
CREATE INDEX "idx_followups_status_scheduled_at" ON "followups" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_lead_scores_business_id" ON "lead_scores" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_lead_scores_created_at" ON "lead_scores" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_lead_scores_classification" ON "lead_scores" USING btree ("classification");--> statement-breakpoint
CREATE INDEX "idx_lead_scores_priority" ON "lead_scores" USING btree ("lead_priority_score");--> statement-breakpoint
CREATE INDEX "idx_lead_state_history_business_id" ON "lead_state_history" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_lead_state_history_business_created" ON "lead_state_history" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_outreach_campaigns_status" ON "outreach_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_outreach_messages_business_id" ON "outreach_messages" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_messages_campaign_id" ON "outreach_messages" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_outreach_messages_status" ON "outreach_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_outreach_messages_contact_id" ON "outreach_messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_payments_customer_id" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_payments_status" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_production_websites_customer_id" ON "production_websites" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_sales_opportunities_status" ON "sales_opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sales_opportunities_business_id" ON "sales_opportunities" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_sales_opportunities_customer_id" ON "sales_opportunities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_scoring_versions_active" ON "scoring_versions" USING btree ("score_type","is_active");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_customer_id" ON "subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_status_scheduled_at" ON "tasks" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_entity" ON "tasks" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_type" ON "tasks" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_website_analyses_website_id" ON "website_analyses" USING btree ("website_id");--> statement-breakpoint
CREATE INDEX "idx_website_analyses_analyzed_at" ON "website_analyses" USING btree ("analyzed_at");--> statement-breakpoint
CREATE INDEX "idx_website_versions_production_website_id" ON "website_versions" USING btree ("production_website_id");--> statement-breakpoint
CREATE INDEX "idx_websites_business_id" ON "websites" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_websites_status" ON "websites" USING btree ("status");