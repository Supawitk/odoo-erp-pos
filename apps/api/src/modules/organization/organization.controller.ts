import { Body, Controller, Get, Patch } from '@nestjs/common';
import { OrganizationService, type OrgPatch } from './organization.service';

@Controller('api/settings')
export class OrganizationController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  get() {
    return this.org.snapshot();
  }

  @Patch()
  update(@Body() body: OrgPatch) {
    return this.org.update(body);
  }
}
