import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { OpenSessionDto, CloseSessionDto } from '../dtos/session.dto';
import {
  OpenSessionCommand,
  CloseSessionCommand,
} from '../../application/commands/session.commands';
import {
  GetCurrentSessionQuery,
  GetSessionSummaryQuery,
  GetSessionsDashboardQuery,
} from '../../application/queries/session.queries';

@Controller('api/pos/sessions')
export class SessionsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post('open')
  @HttpCode(201)
  open(@Body() dto: OpenSessionDto) {
    return this.commandBus.execute(
      new OpenSessionCommand(dto.userId, dto.openingBalanceCents, dto.deviceId),
    );
  }

  @Post(':id/close')
  @HttpCode(200)
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseSessionDto,
  ) {
    return this.commandBus.execute(
      new CloseSessionCommand(id, dto.countedBalanceCents, dto.varianceApprovedBy),
    );
  }

  @Get('current')
  current(@Query('userId', ParseUUIDPipe) userId: string) {
    return this.queryBus.execute(new GetCurrentSessionQuery(userId));
  }

  /**
   * Cheap dashboard rollup — open session count, cash on hand, oldest open
   * timestamp, hours stale. Color thresholds (yellow ≥12h, red ≥24h) are
   * applied client-side so the API stays presentation-agnostic.
   */
  @Get('dashboard')
  dashboard() {
    return this.queryBus.execute(new GetSessionsDashboardQuery());
  }

  @Get(':id/summary')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.queryBus.execute(new GetSessionSummaryQuery(id));
  }
}
