CREATE TABLE "callback_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_url" text NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"request_body" text,
	"request_body_key" text,
	"response_status" integer,
	"response_snippet" text,
	"response_body_key" text,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clock_state" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"offset_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"name" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_scenario_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"name" text,
	"object_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"gateway" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"gateway_app_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"state" text NOT NULL,
	"gateway_txn_id" text,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'BDT' NOT NULL,
	"customer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scenario_override_id" uuid,
	"idempotency_key" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_state" ADD CONSTRAINT "clock_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_apps" ADD CONSTRAINT "gateway_apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_apps" ADD CONSTRAINT "gateway_apps_default_scenario_id_scenarios_id_fk" FOREIGN KEY ("default_scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_gateway_app_id_gateway_apps_id_fk" FOREIGN KEY ("gateway_app_id") REFERENCES "public"."gateway_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_scenario_override_id_scenarios_id_fk" FOREIGN KEY ("scenario_override_id") REFERENCES "public"."scenarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "callback_deliveries_transaction_idx" ON "callback_deliveries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "callback_deliveries_schedule_idx" ON "callback_deliveries" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "events_transaction_timeline_idx" ON "events" USING btree ("transaction_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_gateway_ref_unique" ON "transactions" USING btree ("gateway","gateway_txn_id");--> statement-breakpoint
CREATE INDEX "transactions_workspace_list_idx" ON "transactions" USING btree ("workspace_id","created_at");