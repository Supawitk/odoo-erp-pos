import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import { INestApplication, Logger } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Socket.io Redis adapter — required for multi-instance horizontal scale
 * so events broadcast on one API pod reach clients connected to another.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient?: Redis;
  private subClient?: Redis;
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    this.pubClient = new Redis(url, { maxRetriesPerRequest: null });
    this.subClient = this.pubClient.duplicate();
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.logger.log('Socket.io Redis adapter connected');
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
      },
    });
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
