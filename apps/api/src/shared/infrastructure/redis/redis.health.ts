import { Injectable, Inject } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS } from './redis.module';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const pong = await this.redis.ping();
      const ok = pong === 'PONG';
      const result = this.getStatus(key, ok, { response: pong });
      if (!ok) {
        throw new HealthCheckError('Redis ping failed', result);
      }
      return result;
    } catch (err) {
      throw new HealthCheckError(
        'Redis unreachable',
        this.getStatus(key, false, {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
