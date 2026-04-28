import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { BranchesService, type CreateBranchInput } from './branches.service';

@Controller('api/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  list(@Query('activeOnly') activeOnly?: string) {
    return this.branches.list({ activeOnly: activeOnly !== 'false' });
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.branches.findById(id);
  }

  @Post()
  create(@Body() body: CreateBranchInput) {
    return this.branches.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Partial<CreateBranchInput> & { isActive?: boolean },
  ) {
    return this.branches.update(id, body);
  }
}
