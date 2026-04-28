import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { CqrsModule } from '@nestjs/cqrs';
import { HealthController } from './shared/infrastructure/health/health.controller';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { DatabaseHealthIndicator } from './shared/infrastructure/database/database.health';
import { RedisModule } from './shared/infrastructure/redis/redis.module';
import { RedisHealthIndicator } from './shared/infrastructure/redis/redis.health';
import { OdooModule } from './shared/infrastructure/odoo/odoo.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { PosModule } from './modules/pos/pos.module';
import { ProductsModule } from './modules/products/products.module';
import { ReportsModule } from './modules/reports/reports.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { SalesModule } from './modules/sales/sales.module';
import { JobsModule } from './shared/infrastructure/jobs/jobs.module';
import { AuthModule } from './modules/auth/auth.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 3 },
      { name: 'medium', ttl: 10000, limit: 20 },
      { name: 'long', ttl: 60000, limit: 100 },
    ]),

    TerminusModule,
    CqrsModule.forRoot(),

    DatabaseModule,
    RedisModule,
    OdooModule,
    AuthModule,
    OrganizationModule,
    PosModule,
    ProductsModule,
    ReportsModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
