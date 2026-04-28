import { appSchema, tableSchema } from '@nozbe/watermelondb';

/**
 * WatermelonDB schema for the iPad POS offline queue.
 *
 * Minimal Phase 2 shape:
 *   - `queued_orders` — orders created while offline, awaiting sync
 *   - `products_cache` — last-seen products for offline browsing
 *
 * Storage is encrypted at rest in iOS via the OS file-protection class
 * (`.completeUntilFirstUserAuthentication`) — SQLCipher integration is a
 * Phase 2C hardening step, not code-complete here.
 */
export const watermelonSchema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'queued_orders',
      columns: [
        { name: 'offline_id', type: 'string', isIndexed: true },
        { name: 'session_id', type: 'string' },
        { name: 'payload_json', type: 'string' }, // full create-order DTO
        { name: 'status', type: 'string', isIndexed: true }, // pending | syncing | failed | synced
        { name: 'attempts', type: 'number' },
        { name: 'last_error', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'products_cache',
      columns: [
        { name: 'product_id', type: 'string', isIndexed: true },
        { name: 'name', type: 'string' },
        { name: 'barcode', type: 'string', isOptional: true, isIndexed: true },
        { name: 'sku', type: 'string', isOptional: true },
        { name: 'category', type: 'string', isOptional: true },
        { name: 'price_cents', type: 'number' },
        { name: 'stock_qty', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
  ],
});
