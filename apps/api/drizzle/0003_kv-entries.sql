CREATE TABLE IF NOT EXISTS "kv_entries" (
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kv_entries_ns_key_idx" ON "kv_entries" USING btree ("namespace","key");
