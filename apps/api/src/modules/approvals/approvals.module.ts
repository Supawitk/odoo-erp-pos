import { Global, Module } from '@nestjs/common';
import { TierValidationService } from './tier-validation.service';
import { ApprovalsController } from './approvals.controller';
import { AuthModule } from '../auth/auth.module';

/**
 * Global so any module can inject TierValidationService without circular
 * import gymnastics — refund-order, confirm-PO, post-JE all need it.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [ApprovalsController],
  providers: [TierValidationService],
  exports: [TierValidationService],
})
export class ApprovalsModule {}
