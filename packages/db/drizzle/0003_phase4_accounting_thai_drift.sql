CREATE TABLE "custom"."tier_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target_kind" text NOT NULL,
	"condition_expr" text,
	"sequence" integer DEFAULT 10 NOT NULL,
	"reviewer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."tier_review_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "custom"."tier_review_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"review_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."tier_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now(),
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolver_comment" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requester_comment" text
);
--> statement-breakpoint
CREATE TABLE "custom"."bank_match_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_line_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"source_module" text,
	"source_id" text,
	"amount_cents" bigint NOT NULL,
	"matched_by" text,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"posted_at" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text,
	"bank_ref" text,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"journal_entry_id" uuid,
	"matched_at" timestamp with time zone,
	"matched_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cash_account_code" varchar(10) NOT NULL,
	"bank_label" text NOT NULL,
	"statement_from" date,
	"statement_to" date,
	"opening_balance_cents" bigint,
	"closing_balance_cents" bigint,
	"file_hash" text NOT NULL,
	"source" text NOT NULL,
	"filename" text,
	"imported_by" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."cit_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_year" integer NOT NULL,
	"half_year" boolean DEFAULT false NOT NULL,
	"taxable_income_cents" bigint NOT NULL,
	"tax_due_cents" bigint NOT NULL,
	"wht_credits_cents" bigint DEFAULT 0 NOT NULL,
	"advance_paid_cents" bigint DEFAULT 0 NOT NULL,
	"net_payable_cents" bigint NOT NULL,
	"rate_bracket" varchar(30) NOT NULL,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filed_by" text,
	"rd_filing_reference" text,
	"notes" text,
	"closing_journal_id" uuid
);
--> statement-breakpoint
CREATE TABLE "custom"."depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_no" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"category" varchar(30) DEFAULT 'equipment' NOT NULL,
	"acquisition_date" date NOT NULL,
	"acquisition_cost_cents" bigint NOT NULL,
	"salvage_value_cents" bigint DEFAULT 0 NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" varchar(20) DEFAULT 'straight_line' NOT NULL,
	"asset_account_code" varchar(10) NOT NULL,
	"accumulated_depreciation_account" varchar(10) DEFAULT '1590' NOT NULL,
	"expense_account_code" varchar(10) DEFAULT '6190' NOT NULL,
	"depreciation_start_date" date NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"disposed_at" date,
	"disposal_proceeds_cents" bigint,
	"disposal_journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "fixed_assets_asset_no_unique" UNIQUE("asset_no")
);
--> statement-breakpoint
CREATE TABLE "custom"."branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(5) NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_head_office" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."held_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"label" text NOT NULL,
	"cart_lines" jsonb NOT NULL,
	"buyer" jsonb,
	"cart_discount_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."pp30_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"output_vat_cents" bigint NOT NULL,
	"input_vat_cents" bigint NOT NULL,
	"net_payable_cents" bigint NOT NULL,
	"status" text DEFAULT 'filed' NOT NULL,
	"closing_journal_id" uuid,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filed_by" uuid,
	"rd_filing_reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."bill_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"payment_no" integer NOT NULL,
	"payment_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"wht_cents" bigint DEFAULT 0 NOT NULL,
	"bank_charge_cents" bigint DEFAULT 0 NOT NULL,
	"cash_cents" bigint NOT NULL,
	"cash_account_code" varchar(10) DEFAULT '1120' NOT NULL,
	"payment_method" text,
	"bank_reference" text,
	"journal_entry_id" uuid,
	"paid_by" text,
	"notes" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_received" numeric(14, 3) NOT NULL,
	"qty_accepted" numeric(14, 3) DEFAULT '0' NOT NULL,
	"qty_rejected" numeric(14, 3) DEFAULT '0' NOT NULL,
	"qc_status" text DEFAULT 'pending' NOT NULL,
	"qc_notes" text,
	"unit_cost_cents" bigint NOT NULL,
	"lot_code" text,
	"serial_no" text,
	"expiry_date" date,
	"cost_layer_id" uuid
);
--> statement-breakpoint
CREATE TABLE "custom"."goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grn_number" varchar(32) NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"received_date" date NOT NULL,
	"destination_warehouse_id" uuid NOT NULL,
	"supplier_delivery_note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"received_by" text,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_employee" boolean DEFAULT false NOT NULL,
	"email" text,
	"phone" text,
	"tin" varchar(13),
	"tin_encrypted" "bytea",
	"tin_hash" text,
	"branch_code" varchar(5) DEFAULT '00000',
	"vat_registered" boolean DEFAULT false NOT NULL,
	"address" jsonb,
	"default_currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"wht_category" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."purchase_order_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"amended_by" text,
	"amended_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"description" text,
	"qty_ordered" numeric(14, 3) NOT NULL,
	"qty_received" numeric(14, 3) DEFAULT '0' NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"vat_category" text DEFAULT 'standard' NOT NULL,
	"excise_cents" bigint DEFAULT 0 NOT NULL,
	"line_total_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom"."purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_number" varchar(32) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"order_date" date NOT NULL,
	"expected_delivery_date" date,
	"destination_warehouse_id" uuid NOT NULL,
	"currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"fx_rate_to_thb" numeric(14, 6) DEFAULT '1.0',
	"vat_mode" text DEFAULT 'exclusive' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"vat_breakdown" jsonb,
	"notes" text,
	"created_by" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."vendor_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"net_cents" bigint NOT NULL,
	"vat_category" text DEFAULT 'standard' NOT NULL,
	"vat_mode" text DEFAULT 'exclusive' NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"wht_category" text,
	"wht_rate_bp" integer,
	"wht_cents" bigint DEFAULT 0 NOT NULL,
	"wht_payer_mode" text,
	"expense_account_code" varchar(10),
	"purchase_order_line_id" uuid,
	"goods_receipt_line_id" uuid,
	"match_status" text,
	"match_variance_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."vendor_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"internal_number" varchar(32) NOT NULL,
	"supplier_invoice_number" text,
	"supplier_tax_invoice_number" text,
	"supplier_tax_invoice_date" date,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"bill_date" date NOT NULL,
	"due_date" date,
	"currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"fx_rate_to_thb" numeric(14, 6) DEFAULT '1.0' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"wht_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"vat_breakdown" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"payment_journal_entry_id" uuid,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"wht_paid_cents" bigint DEFAULT 0 NOT NULL,
	"input_vat_reclassed_at" timestamp with time zone,
	"input_vat_reclass_journal_id" uuid,
	"pp30_filing_id" uuid,
	"match_status" text,
	"match_override_by" text,
	"match_override_reason" text,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."invoice_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_invoice_id" uuid NOT NULL,
	"receipt_no" integer NOT NULL,
	"receipt_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"wht_cents" bigint DEFAULT 0 NOT NULL,
	"bank_charge_cents" bigint DEFAULT 0 NOT NULL,
	"cash_cents" bigint NOT NULL,
	"cash_account_code" varchar(10) DEFAULT '1120' NOT NULL,
	"payment_method" text,
	"bank_reference" text,
	"journal_entry_id" uuid,
	"received_by" text,
	"notes" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."sales_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"net_cents" bigint NOT NULL,
	"vat_category" text DEFAULT 'standard' NOT NULL,
	"vat_mode" text DEFAULT 'exclusive' NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"wht_category" text,
	"wht_rate_bp" integer,
	"wht_cents" bigint DEFAULT 0 NOT NULL,
	"revenue_account_code" varchar(10),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"internal_number" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_reference" text,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"fx_rate_to_thb" numeric(14, 6) DEFAULT '1.0',
	"vat_mode" text DEFAULT 'exclusive' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"wht_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"vat_breakdown" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"payment_journal_entry_id" uuid,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"wht_received_cents" bigint DEFAULT 0 NOT NULL,
	"pp30_filing_id" uuid,
	"notes" text,
	"sent_at" timestamp with time zone,
	"sent_by" text,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"cancelled_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "custom"."users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
DROP INDEX "custom"."document_sequences_pk";--> statement-breakpoint
DROP INDEX "custom"."products_name_trgm_idx";--> statement-breakpoint
ALTER TABLE "custom"."users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."stock_moves" ALTER COLUMN "performed_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "custom"."stock_moves" ALTER COLUMN "approved_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "custom"."chart_of_accounts" ADD COLUMN "name_th" text;--> statement-breakpoint
ALTER TABLE "custom"."chart_of_accounts" ADD COLUMN "name_en" text;--> statement-breakpoint
ALTER TABLE "custom"."chart_of_accounts" ADD COLUMN "is_cash_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."journal_entries" ADD COLUMN "currency" varchar(3) DEFAULT 'THB' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."journal_entries" ADD COLUMN "total_debit_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."journal_entries" ADD COLUMN "total_credit_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."journal_entry_lines" ADD COLUMN "non_deductible_category" text;--> statement-breakpoint
ALTER TABLE "custom"."journal_entry_lines" ADD COLUMN "non_deductible_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."journal_entry_lines" ADD COLUMN "non_deductible_reason" text;--> statement-breakpoint
ALTER TABLE "custom"."refresh_tokens" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "custom"."refresh_tokens" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "custom"."refresh_tokens" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "custom"."users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "custom"."stock_moves" ADD COLUMN "layer_consumption" jsonb;--> statement-breakpoint
ALTER TABLE "custom"."organizations" ADD COLUMN "seller_tin_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "custom"."organizations" ADD COLUMN "promptpay_refund_id" text;--> statement-breakpoint
ALTER TABLE "custom"."organizations" ADD COLUMN "feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."organizations" ADD COLUMN "default_bank_charge_account" varchar(10) DEFAULT '6170' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."document_sequences" ADD COLUMN "branch_code" varchar(5) DEFAULT '00000' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_tin_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_tin_hash" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_address_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "pp30_filing_id" uuid;--> statement-breakpoint
ALTER TABLE "custom"."tier_review_events" ADD CONSTRAINT "tier_review_events_review_id_tier_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "custom"."tier_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."tier_review_events" ADD CONSTRAINT "tier_review_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "custom"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."tier_reviews" ADD CONSTRAINT "tier_reviews_definition_id_tier_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "custom"."tier_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."tier_reviews" ADD CONSTRAINT "tier_reviews_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "custom"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."tier_reviews" ADD CONSTRAINT "tier_reviews_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "custom"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."cit_filings" ADD CONSTRAINT "cit_filings_closing_journal_id_journal_entries_id_fk" FOREIGN KEY ("closing_journal_id") REFERENCES "custom"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."depreciation_entries" ADD CONSTRAINT "depreciation_entries_fixed_asset_id_fixed_assets_id_fk" FOREIGN KEY ("fixed_asset_id") REFERENCES "custom"."fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."depreciation_entries" ADD CONSTRAINT "depreciation_entries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "custom"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "custom"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."branches" ADD CONSTRAINT "branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "custom"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom"."held_carts" ADD CONSTRAINT "held_carts_session_id_pos_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "custom"."pos_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tier_def_kind_active_idx" ON "custom"."tier_definitions" USING btree ("target_kind","is_active");--> statement-breakpoint
CREATE INDEX "tier_rev_event_review_idx" ON "custom"."tier_review_events" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE INDEX "tier_rev_target_idx" ON "custom"."tier_reviews" USING btree ("target_kind","target_id","status");--> statement-breakpoint
CREATE INDEX "bml_bank_idx" ON "custom"."bank_match_links" USING btree ("bank_line_id");--> statement-breakpoint
CREATE INDEX "bml_journal_idx" ON "custom"."bank_match_links" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bml_journal_unique_idx" ON "custom"."bank_match_links" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bsl_fingerprint_idx" ON "custom"."bank_statement_lines" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "bsl_statement_idx" ON "custom"."bank_statement_lines" USING btree ("statement_id","line_no");--> statement-breakpoint
CREATE INDEX "bsl_status_idx" ON "custom"."bank_statement_lines" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bsl_posted_idx" ON "custom"."bank_statement_lines" USING btree ("posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_file_hash_idx" ON "custom"."bank_statements" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "bank_statements_account_idx" ON "custom"."bank_statements" USING btree ("cash_account_code","statement_from");--> statement-breakpoint
CREATE UNIQUE INDEX "cit_year_half_idx" ON "custom"."cit_filings" USING btree ("fiscal_year","half_year");--> statement-breakpoint
CREATE UNIQUE INDEX "dep_asset_period_idx" ON "custom"."depreciation_entries" USING btree ("fixed_asset_id","period");--> statement-breakpoint
CREATE INDEX "dep_period_idx" ON "custom"."depreciation_entries" USING btree ("period");--> statement-breakpoint
CREATE INDEX "fa_status_idx" ON "custom"."fixed_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fa_acq_date_idx" ON "custom"."fixed_assets" USING btree ("acquisition_date");--> statement-breakpoint
CREATE INDEX "held_carts_session_idx" ON "custom"."held_carts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "pp30_filings_filed_at_idx" ON "custom"."pp30_filings" USING btree ("filed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_payments_bill_no_idx" ON "custom"."bill_payments" USING btree ("vendor_bill_id","payment_no");--> statement-breakpoint
CREATE INDEX "bill_payments_bill_date_idx" ON "custom"."bill_payments" USING btree ("vendor_bill_id","payment_date");--> statement-breakpoint
CREATE INDEX "bill_payments_date_idx" ON "custom"."bill_payments" USING btree ("payment_date");--> statement-breakpoint
CREATE INDEX "grn_lines_grn_idx" ON "custom"."goods_receipt_lines" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "grn_lines_po_line_idx" ON "custom"."goods_receipt_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "grn_lines_product_idx" ON "custom"."goods_receipt_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "grn_lines_qc_status_idx" ON "custom"."goods_receipt_lines" USING btree ("qc_status");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_grn_number_idx" ON "custom"."goods_receipts" USING btree ("grn_number");--> statement-breakpoint
CREATE INDEX "goods_receipts_po_status_idx" ON "custom"."goods_receipts" USING btree ("purchase_order_id","status");--> statement-breakpoint
CREATE INDEX "goods_receipts_received_date_idx" ON "custom"."goods_receipts" USING btree ("received_date");--> statement-breakpoint
CREATE INDEX "partners_name_idx" ON "custom"."partners" USING btree ("name");--> statement-breakpoint
CREATE INDEX "partners_supplier_idx" ON "custom"."partners" USING btree ("is_supplier");--> statement-breakpoint
CREATE INDEX "partners_customer_idx" ON "custom"."partners" USING btree ("is_customer");--> statement-breakpoint
CREATE UNIQUE INDEX "partners_tin_branch_idx" ON "custom"."partners" USING btree ("tin","branch_code");--> statement-breakpoint
CREATE INDEX "partners_tin_hash_idx" ON "custom"."partners" USING btree ("tin_hash");--> statement-breakpoint
CREATE INDEX "partners_active_idx" ON "custom"."partners" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "po_amendments_po_version_idx" ON "custom"."purchase_order_amendments" USING btree ("purchase_order_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "po_lines_po_lineno_idx" ON "custom"."purchase_order_lines" USING btree ("purchase_order_id","line_no");--> statement-breakpoint
CREATE INDEX "po_lines_product_idx" ON "custom"."purchase_order_lines" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_po_number_idx" ON "custom"."purchase_orders" USING btree ("po_number");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_status_idx" ON "custom"."purchase_orders" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_order_date_idx" ON "custom"."purchase_orders" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "custom"."purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "vbl_bill_lineno_idx" ON "custom"."vendor_bill_lines" USING btree ("vendor_bill_id","line_no");--> statement-breakpoint
CREATE INDEX "vbl_po_line_idx" ON "custom"."vendor_bill_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "vbl_grn_line_idx" ON "custom"."vendor_bill_lines" USING btree ("goods_receipt_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_internal_number_idx" ON "custom"."vendor_bills" USING btree ("internal_number");--> statement-breakpoint
CREATE INDEX "vendor_bills_supplier_idx" ON "custom"."vendor_bills" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_po_idx" ON "custom"."vendor_bills" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_status_idx" ON "custom"."vendor_bills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vendor_bills_date_idx" ON "custom"."vendor_bills" USING btree ("bill_date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_receipts_inv_no_idx" ON "custom"."invoice_receipts" USING btree ("sales_invoice_id","receipt_no");--> statement-breakpoint
CREATE INDEX "invoice_receipts_inv_date_idx" ON "custom"."invoice_receipts" USING btree ("sales_invoice_id","receipt_date");--> statement-breakpoint
CREATE INDEX "invoice_receipts_date_idx" ON "custom"."invoice_receipts" USING btree ("receipt_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sil_invoice_lineno_idx" ON "custom"."sales_invoice_lines" USING btree ("sales_invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "sil_product_idx" ON "custom"."sales_invoice_lines" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_internal_number_idx" ON "custom"."sales_invoices" USING btree ("internal_number");--> statement-breakpoint
CREATE INDEX "sales_invoices_customer_idx" ON "custom"."sales_invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sales_invoices_customer_status_idx" ON "custom"."sales_invoices" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "sales_invoices_invoice_date_idx" ON "custom"."sales_invoices" USING btree ("invoice_date");--> statement-breakpoint
CREATE INDEX "sales_invoices_status_idx" ON "custom"."sales_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "custom"."journal_entries" USING btree ("source_module","source_id");--> statement-breakpoint
CREATE INDEX "jel_non_deductible_idx" ON "custom"."journal_entry_lines" USING btree ("non_deductible_category");--> statement-breakpoint
CREATE INDEX "pos_orders_buyer_tin_hash_idx" ON "custom"."pos_orders" USING btree ("buyer_tin_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "document_sequences_pk" ON "custom"."document_sequences" USING btree ("document_type","period","branch_code");--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "custom"."products" USING gin ("name" gin_trgm_ops);