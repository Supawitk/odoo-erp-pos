import { Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { ValuationService } from '../application/valuation.service';
import { LowExpiryAlertEvent } from '../domain/events';

/**
 * Daily expiry-soon scan. Runs at 09:00 Asia/Bangkok and emits one
 * LowExpiryAlertEvent per cost-layer that has qty_remaining > 0 and an
 * expiry_date within 30 days.
 *
 * Triggered by BullMQ Job Scheduler v5 (`inventory-expiry-scan`, 09:00 daily,
 * Asia/Bangkok).
 */
@Injectable()
export class ExpiryCronService {
  private readonly logger = new Logger(ExpiryCronService.name);

  constructor(
    private readonly valuation: ValuationService,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Daily expiry scan. Triggered by BullMQ Job Scheduler
   * (`inventory-expiry-scan`, 09:00 Asia/Bangkok). Public-callable for tests
   * + the manual `/api/inventory/expiring/run` trigger.
   */
  async scan(daysAhead: number): Promise<{ alertsEmitted: number; cutoffDays: number }> {
    const layers = await this.valuation.getExpiringSoon(daysAhead);
    let emitted = 0;
    for (const layer of layers) {
      if (!layer.expiryDate || layer.daysToExpiry == null) continue;
      this.eventBus.publish(
        new LowExpiryAlertEvent(
          layer.productId,
          layer.id,
          layer.lotCode,
          layer.serialNo,
          layer.qtyRemaining,
          new Date(layer.expiryDate),
          layer.daysToExpiry,
          new Date(),
        ),
      );
      emitted += 1;
    }
    this.logger.log(
      `Expiry scan complete: ${emitted} alerts emitted within ${daysAhead}-day window`,
    );
    return { alertsEmitted: emitted, cutoffDays: daysAhead };
  }
}
