import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { DatabaseHealthIndicator } from '../database/database.health';
import { RedisHealthIndicator } from '../redis/redis.health';
import { OdooHealthIndicator } from '../odoo/odoo.health';
import { Public } from '../../../modules/auth/jwt-auth.guard';

@Controller('health')
@SkipThrottle()
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly odoo: OdooHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.isHealthy('postgres'),
      () => this.redis.isHealthy('redis'),
      () => this.odoo.isHealthy('odoo'),
    ]);
  }
}
