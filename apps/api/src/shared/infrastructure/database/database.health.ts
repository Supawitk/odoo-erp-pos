import { Injectable, Inject } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from './database.module';

@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  constructor(@Inject(DRIZZLE) private readonly db: any) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError(
        'PostgreSQL unreachable',
        this.getStatus(key, false, {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
