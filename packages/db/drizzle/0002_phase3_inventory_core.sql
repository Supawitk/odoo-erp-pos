CREATE TABLE "custom"."cost_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"lot_code" text,
	"serial_no" text,
	"expiry_date" date,
	"removal_date" date,
	"qty_received" numeric(14, 3) NOT NULL,
	"qty_remaining" numeric(14, 3) NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'THB' NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_move_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."cycle_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"expected_qty" numeric(14, 3) NOT NULL,
	"counted_qty" numeric(14, 3),
	"variance_qty" numeric(14, 3),
	"variance_value_cents" bigint,
	"auto_accepted" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "custom"."cycle_count_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"counter_user_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"blind_count_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"approved_by" uuid,
	"variance_total_cents" bigint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."odoo_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"odoo_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."stock_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"move_type" text NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"from_warehouse_id" uuid,
	"to_warehouse_id" uuid,
	"cost_layer_id" uuid,
	"unit_cost_cents" bigint,
	"source_module" text,
	"source_id" text,
	"reference" text,
	"performed_by" uuid,
	"approved_by" uuid,
	"reason" text,
	"branch_code" varchar(5),
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."stock_quants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"qty_on_hand" numeric(14, 3) DEFAULT '0' NOT NULL,
	"qty_reserved" numeric(14, 3) DEFAULT '0' NOT NULL,
	"avg_cost_cents" bigint,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "custom"."warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"branch_code" varchar(5) DEFAULT '00000',
	"address_line" text,
	"timezone" text DEFAULT 'Asia/Bangkok' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "avg_cost_cents" bigint;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "tracking_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "unit_of_measure" text DEFAULT 'piece' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "reorder_point" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "reorder_qty" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "lead_time_days" integer;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "vat_category" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "input_vat_claimable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "input_vat_disallow_reason" text;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "excise_category" text;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "excise_specific_cents_per_unit" bigint;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "excise_ad_valorem_bp" integer;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "sugar_g_per_100ml" integer;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "volume_ml" integer;--> statement-breakpoint
ALTER TABLE "custom"."products" ADD COLUMN "abv_bp" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_layers_serial_unique_idx" ON "custom"."cost_layers" USING btree ("product_id","serial_no") WHERE "serial_no" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cost_layers_fefo_idx" ON "custom"."cost_layers" USING btree ("product_id","warehouse_id","expiry_date","received_at");--> statement-breakpoint
CREATE INDEX "cost_layers_expiry_soon_idx" ON "custom"."cost_layers" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "cost_layers_status_idx" ON "custom"."cost_layers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cycle_count_lines_session_idx" ON "custom"."cycle_count_lines" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cycle_count_warehouse_status_idx" ON "custom"."cycle_count_sessions" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "odoo_outbox_status_next_idx" ON "custom"."odoo_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "odoo_outbox_external_id_unique_idx" ON "custom"."odoo_outbox" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_moves_source_unique_idx" ON "custom"."stock_moves" USING btree ("source_module","source_id","product_id") WHERE "source_module" IS NOT NULL AND "source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_moves_product_date_idx" ON "custom"."stock_moves" USING btree ("product_id","performed_at");--> statement-breakpoint
CREATE INDEX "stock_moves_branch_date_idx" ON "custom"."stock_moves" USING btree ("branch_code","performed_at");--> statement-breakpoint
CREATE INDEX "stock_moves_type_date_idx" ON "custom"."stock_moves" USING btree ("move_type","performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_quants_pw_unique_idx" ON "custom"."stock_quants" USING btree ("product_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_quants_product_idx" ON "custom"."stock_quants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stock_quants_warehouse_idx" ON "custom"."stock_quants" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_code_unique_idx" ON "custom"."warehouses" USING btree ("code");--> statement-breakpoint
CREATE INDEX "warehouses_active_idx" ON "custom"."warehouses" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "products_vat_category_idx" ON "custom"."products" USING btree ("vat_category");--> statement-breakpoint
CREATE INDEX "products_excise_idx" ON "custom"."products" USING btree ("excise_category");