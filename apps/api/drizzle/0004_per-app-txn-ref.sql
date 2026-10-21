DROP INDEX IF EXISTS "transactions_gateway_ref_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_app_ref_unique" ON "transactions" USING btree ("gateway","gateway_app_id","gateway_txn_id");
