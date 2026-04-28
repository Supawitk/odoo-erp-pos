CREATE SCHEMA "custom";
--> statement-breakpoint
CREATE TABLE "custom"."chart_of_accounts" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"parent_code" varchar(10),
	"is_active" boolean DEFAULT true NOT NULL,
	"normal_balance" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_number" serial NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"source_module" text,
	"source_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"voided_by_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."journal_entry_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"account_code" varchar(10) NOT NULL,
	"account_name" text NOT NULL,
	"debit_cents" bigint DEFAULT 0 NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"description" text,
	"partner_id" text
);
--> statement-breakpoint
CREATE TABLE "custom"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_data" jsonb NOT NULL,
	"user_id" uuid,
	"user_email" text,
	"ip_address" text,
	"timestamp" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"odoo_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"data_hash" text,
	"error_message" text,
	"synced_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"device_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'cashier' NOT NULL,
	"odoo_user_id" integer,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "custom"."pos_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odoo_order_id" integer,
	"session_id" uuid,
	"customer_id" uuid,
	"order_lines" jsonb NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"payment_method" text NOT NULL,
	"payment_details" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"ipad_device_id" text,
	"offline_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pos_orders_offline_id_unique" UNIQUE("offline_id")
);
--> statement-breakpoint
CREATE TABLE "custom"."pos_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opening_balance_cents" bigint NOT NULL,
	"closing_balance_cents" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"device_id" text,
	"opened_at" timestamp with time zone DEFAULT now(),
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom"."rag_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid,
	"chunk" text NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "custom"."rag_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"type" text NOT NULL,
	"source_model" text,
	"source_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "custom"."journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "custom"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "custom"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD CONSTRAINT "pos_orders_session_id_pos_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "custom"."pos_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."rag_embeddings" ADD CONSTRAINT "rag_embeddings_resource_id_rag_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "custom"."rag_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "custom"."journal_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "journal_entries_status_idx" ON "custom"."journal_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jel_entry_idx" ON "custom"."journal_entry_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "jel_account_idx" ON "custom"."journal_entry_lines" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "audit_aggregate_idx" ON "custom"."audit_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "audit_timestamp_idx" ON "custom"."audit_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "sync_model_idx" ON "custom"."sync_log" USING btree ("model","odoo_id");--> statement-breakpoint
CREATE INDEX "pos_orders_date_idx" ON "custom"."pos_orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pos_orders_session_idx" ON "custom"."pos_orders" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "pos_orders_offline_idx" ON "custom"."pos_orders" USING btree ("offline_id");--> statement-breakpoint
CREATE INDEX "embedding_hnsw_idx" ON "custom"."rag_embeddings" USING hnsw ("embedding" vector_cosine_ops);