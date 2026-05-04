import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres `bytea` column for raw binary blobs (e.g. pgcrypto ciphertext).
 *
 * Drizzle doesn't ship a first-class `bytea` type — postgres-js round-trips
 * it as Buffer naturally, so we just need a thin customType so the column
 * appears in introspection + migrations.
 */
export const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});
