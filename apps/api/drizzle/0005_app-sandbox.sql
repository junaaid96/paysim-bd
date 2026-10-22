ALTER TABLE "gateway_apps" ADD COLUMN IF NOT EXISTS "sandbox" jsonb DEFAULT '{}'::jsonb NOT NULL;
