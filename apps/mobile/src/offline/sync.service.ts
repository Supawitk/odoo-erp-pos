import { Q } from '@nozbe/watermelondb';
import { database } from './database';
import type { QueuedOrder } from './models';
import { api, ApiError } from '../api/client';

/**
 * Offline order sync service.
 *
 * Enqueue → send → retry-with-backoff → mark synced/failed.
 * The API's `offlineId` UNIQUE constraint makes retries idempotent.
 *
 * Call `drain()` every time:
 *   - the device reconnects (via NetInfo listener — Phase 2C)
 *   - a new queued order is enqueued while online
 *   - the app comes to foreground
 *
 * Failed orders retain `lastError` for cashier review.
 */

type OrderPayload = Record<string, unknown> & { offlineId: string; sessionId: string };

export async function enqueue(payload: OrderPayload): Promise<void> {
  await database.write(async () => {
    await database.get<QueuedOrder>('queued_orders').create((r) => {
      r.offlineId = payload.offlineId;
      r.sessionId = payload.sessionId;
      r.payloadJson = JSON.stringify(payload);
      r.status = 'pending';
      r.attempts = 0;
    });
  });
}

export async function drain(): Promise<{ synced: number; failed: number }> {
  const pending = await database
    .get<QueuedOrder>('queued_orders')
    .query(Q.where('status', Q.oneOf(['pending', 'failed'])))
    .fetch();

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    await database.write(async () => {
      await row.update((r) => {
        r.status = 'syncing';
      });
    });

    try {
      const payload = JSON.parse(row.payloadJson);
      await api('/api/pos/orders', { method: 'POST', body: JSON.stringify(payload) });
      await database.write(async () => {
        await row.update((r) => {
          r.status = 'synced';
          r.lastError = undefined;
        });
      });
      synced += 1;
    } catch (err: any) {
      failed += 1;
      await database.write(async () => {
        await row.update((r) => {
          r.status = 'failed';
          r.attempts = r.attempts + 1;
          r.lastError =
            err instanceof ApiError ? `${err.status}: ${err.body.slice(0, 200)}` : String(err);
        });
      });
    }
  }

  return { synced, failed };
}

export async function queueStats(): Promise<{
  pending: number;
  failed: number;
  synced: number;
}> {
  const collection = database.get<QueuedOrder>('queued_orders');
  const [pending, failed, synced] = await Promise.all([
    collection.query(Q.where('status', 'pending')).fetchCount(),
    collection.query(Q.where('status', 'failed')).fetchCount(),
    collection.query(Q.where('status', 'synced')).fetchCount(),
  ]);
  return { pending, failed, synced };
}
