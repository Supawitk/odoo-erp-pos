import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { HeldCartsService, type HoldCartInput } from '../../application/held-carts.service';

@Controller('api/pos/held-carts')
export class HeldCartsController {
  constructor(private readonly held: HeldCartsService) {}

  @Get()
  list(@Query('sessionId') sessionId?: string) {
    return this.held.list(sessionId);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.held.findById(id);
  }

  @Post()
  hold(@Body() body: HoldCartInput) {
    return this.held.hold(body);
  }

  @Post(':id/recall')
  recall(@Param('id') id: string, @Body() body: { sessionId?: string }) {
    return this.held.recall(id, { sessionId: body?.sessionId });
  }

  @Delete(':id')
  cancel(@Param('id') id: string) {
    return this.held.cancel(id);
  }
}
