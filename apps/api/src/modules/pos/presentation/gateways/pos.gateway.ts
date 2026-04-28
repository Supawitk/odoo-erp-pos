import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:5173',
      'http://localhost:3000',
    ],
    credentials: true,
  },
})
export class PosGateway implements OnGatewayInit {
  private readonly logger = new Logger(PosGateway.name);

  @WebSocketServer()
  server!: Server;

  afterInit(server: Server) {
    this.logger.log(`Socket.io gateway initialized`);
  }

  /** Broadcast an event to every connected iPad in a store. */
  broadcastToStore(storeId: string, event: string, data: unknown) {
    this.server.to(`store:${storeId}`).emit(event, data);
  }

  /** Broadcast order-completed to all POS listeners. Includes messageId for client-side dedup. */
  broadcastOrderCompleted(payload: {
    messageId: string;
    orderId: string;
    sessionId: string;
    totalCents: number;
    currency: string;
    occurredAt: Date;
  }) {
    this.server.emit('pos:order:created', payload);
  }

  /** Broadcast low-stock alert to dashboard + iPad. */
  broadcastLowStock(payload: {
    messageId: string;
    productId: string;
    productName: string;
    warehouseId: string;
    qtyOnHand: number;
    reorderPoint: number;
    suggestedReorderQty: number | null;
    occurredAt: Date;
  }) {
    this.server.emit('inventory:low-stock', payload);
  }
}
