import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class QueuedOrder extends Model {
  static table = 'queued_orders';

  @field('offline_id') offlineId!: string;
  @field('session_id') sessionId!: string;
  @field('payload_json') payloadJson!: string;
  @field('status') status!: string;
  @field('attempts') attempts!: number;
  @field('last_error') lastError?: string;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

export class ProductCache extends Model {
  static table = 'products_cache';

  @field('product_id') productId!: string;
  @field('name') name!: string;
  @field('barcode') barcode?: string;
  @field('sku') sku?: string;
  @field('category') category?: string;
  @field('price_cents') priceCents!: number;
  @field('stock_qty') stockQty!: number;
  @readonly @date('updated_at') updatedAt!: Date;
}
