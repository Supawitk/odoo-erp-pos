import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { GoodsReceivedEvent } from '../../../purchasing/domain/events';
import { StockService } from '../stock.service';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { goodsReceiptLines, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';

/**
 * Listens for GoodsReceivedEvent (published when a GRN is posted). For each
 * QC-passed line, calls StockService.receiveStock to:
 *   1. Create a cost_layer (with lot/serial/expiry from the GRN)
 *   2. Insert a 'receive' stock_move
 *   3. Update the stock_quants cache
 *   4. Recompute the moving-average cost
 *
 * Failed/quarantine lines are deliberately ignored — they sit on the GRN
 * awaiting disposition (return-to-vendor, write-off, retest).
 *
 * Idempotent via stock_moves UNIQUE on (sourceModule, sourceId, productId).
 * Replaying a posted GRN is safe.
 */
@Injectable()
@EventsHandler(GoodsReceivedEvent)
export class OnGoodsReceivedHandler implements IEventHandler<GoodsReceivedEvent> {
  private readonly logger = new Logger(OnGoodsReceivedHandler.name);

  constructor(
    private readonly stock: StockService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  async handle(event: GoodsReceivedEvent): Promise<void> {
    let receivedCount = 0;
    let skippedCount = 0;

    for (const line of event.lines) {
      if (line.qcStatus !== 'passed') {
        skippedCount += 1;
        continue;
      }
      if (line.qtyAccepted <= 0) {
        skippedCount += 1;
        continue;
      }

      try {
        const result = await this.stock.receiveStock({
          productId: line.productId,
          warehouseId: event.destinationWarehouseId,
          qty: line.qtyAccepted,
          unitCostCents: line.unitCostCents,
          lotCode: line.lotCode ?? undefined,
          serialNo: line.serialNo ?? undefined,
          expiryDate: line.expiryDate ?? undefined,
          sourceModule: 'grn',
          sourceId: line.grnLineId,
          reference: event.grnNumber,
          performedBy: 'grn-handler',
        });

        // Back-link cost_layer onto the GRN line for traceability.
        await this.db
          .update(goodsReceiptLines)
          .set({ costLayerId: result.layerId })
          .where(eq(goodsReceiptLines.id, line.grnLineId));

        receivedCount += 1;
      } catch (err) {
        this.logger.error(
          `Failed to receive stock for GRN line ${line.grnLineId} (product ${line.productId})`,
          err as Error,
        );
        // Don't rethrow — keep processing remaining lines.
      }
    }

    this.logger.log(
      `GRN ${event.grnNumber}: ${receivedCount} lines stocked, ${skippedCount} skipped (QC failed/quarantine/zero)`,
    );
  }
}
