import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { watermelonSchema } from './schema';
import { QueuedOrder, ProductCache } from './models';

/**
 * WatermelonDB singleton. Initialised lazily on first import.
 * JSI is enabled so reads/writes happen on the JS thread without bridge
 * round-trips — essential for sub-100ms offline order append.
 */
const adapter = new SQLiteAdapter({
  schema: watermelonSchema,
  jsi: true,
  onSetUpError: (err) => {
    // eslint-disable-next-line no-console
    console.error('[WatermelonDB] setup failed:', err);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [QueuedOrder, ProductCache],
});
