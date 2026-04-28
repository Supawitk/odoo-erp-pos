import { Global, Module } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { OrganizationController } from './organization.controller';
import { BranchesService } from './branches.service';
import { BranchesController } from './branches.controller';

@Global()
@Module({
  providers: [OrganizationService, BranchesService],
  controllers: [OrganizationController, BranchesController],
  exports: [OrganizationService, BranchesService],
})
export class OrganizationModule {}
