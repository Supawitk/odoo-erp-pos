CREATE TABLE "custom"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_mode" text DEFAULT 'TH' NOT NULL,
	"vat_registered" boolean DEFAULT true NOT NULL,
	"currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"locale" text DEFAULT 'th-TH' NOT NULL,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"seller_name" text DEFAULT '' NOT NULL,
	"seller_tin" text,
	"seller_branch" text DEFAULT '00000',
	"seller_address" text DEFAULT '',
	"vat_rate" numeric(5, 4) DEFAULT '0.0700' NOT NULL,
	"default_vat_mode" text DEFAULT 'exclusive' NOT NULL,
	"abbreviated_tax_invoice_cap_cents" bigint DEFAULT 100000 NOT NULL,
	"promptpay_biller_id" text,
	"fx_source" text DEFAULT 'BOT_MID' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."document_sequences" (
	"document_type" text NOT NULL,
	"period" varchar(6) NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"prefix" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odoo_product_id" integer,
	"name" text NOT NULL,
	"barcode" text,
	"sku" text,
	"category" text,
	"price_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"stock_qty" numeric(14, 3) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "products_odoo_product_id_unique" UNIQUE("odoo_product_id")
);
--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "document_type" text DEFAULT 'RE' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "document_number" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_tin" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_branch" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "buyer_address" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "vat_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "promptpay_ref" text;--> statement-breakpoint
ALTER TABLE "custom"."pos_orders" ADD COLUMN "original_order_id" uuid;--> statement-breakpoint
ALTER TABLE "custom"."pos_sessions" ADD COLUMN "expected_balance_cents" bigint;--> statement-breakpoint
ALTER TABLE "custom"."pos_sessions" ADD COLUMN "variance_cents" bigint;--> statement-breakpoint
ALTER TABLE "custom"."pos_sessions" ADD COLUMN "variance_approved_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "document_sequences_pk" ON "custom"."document_sequences" USING btree ("document_type","period");--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "custom"."products" USING gin ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "products_barcode_unique_idx" ON "custom"."products" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "products_active_idx" ON "custom"."products" USING btree ("is_active","name");--> statement-breakpoint
CREATE INDEX "pos_orders_doc_num_idx" ON "custom"."pos_orders" USING btree ("document_type","document_number");