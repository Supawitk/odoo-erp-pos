import { Module, Global } from '@nestjs/common';
import { OdooJsonRpcClient } from './odoo-jsonrpc.client';
import { OdooHealthIndicator } from './odoo.health';

@Global()
@Module({
  providers: [OdooJsonRpcClient, OdooHealthIndicator],
  exports: [OdooJsonRpcClient, OdooHealthIndicator],
})
export class OdooModule {}
