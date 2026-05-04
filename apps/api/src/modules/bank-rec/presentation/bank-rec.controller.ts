import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { BankRecService } from '../application/bank-rec.service';
import { Roles } from '../../auth/jwt-auth.guard';

@Controller('api/bank-rec')
export class BankRecController {
  constructor(private readonly svc: BankRecService) {}

  /**
   * Import a statement file. Body shape:
   *   {
   *     cashAccountCode: '1120',          // required
   *     bankLabel?: 'KBank checking',
   *     source?: 'auto' | 'ofx' | 'csv',
   *     filename?: 'aug-2026.csv',
   *     fileBytes: '<raw text contents>'  // required
   *   }
   *
   * Returns the new statement id + per-line counts. Duplicate file uploads
   * (same SHA-256) → 409 with the existing statement id.
   */
  @Post('statements/import')
  @Roles('admin', 'accountant')
  @HttpCode(201)
  importStatement(
    @Body()
    body: {
      cashAccountCode: string;
      bankLabel?: string;
      source?: 'auto' | 'ofx' | 'csv';
      filename?: string;
      fileBytes: string;
      importedBy?: string;
    },
  ) {
    if (!body?.cashAccountCode) {
      throw new BadRequestException('cashAccountCode required');
    }
    return this.svc.import({
      cashAccountCode: body.cashAccountCode,
      bankLabel: body.bankLabel,
      source: body.source ?? 'auto',
      filename: body.filename,
      fileBytes: body.fileBytes,
      importedBy: body.importedBy,
    });
  }

  @Get('statements')
  @Roles('admin', 'accountant')
  listStatements(
    @Query('cashAccountCode') cashAccountCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listStatements({
      cashAccountCode,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('statements/:id/lines')
  @Roles('admin', 'accountant')
  listLines(@Param('id') id: string) {
    return this.svc.listLines(id);
  }

  /**
   * Suggest matches for a single bank line. Optional query params:
   *   dateWindowDays — default 3
   *   topN           — default 5
   */
  @Get('lines/:id/suggestions')
  @Roles('admin', 'accountant')
  suggest(
    @Param('id') id: string,
    @Query('dateWindowDays') dateWindowDays?: string,
    @Query('topN') topN?: string,
  ) {
    return this.svc.suggestForLine(id, {
      dateWindowDays: dateWindowDays ? Number(dateWindowDays) : undefined,
      topN: topN ? Number(topN) : undefined,
    });
  }

  /**
   * Confirm a match. Sum of link.amountCents must equal the bank line
   * amount. Body:
   *   { links: [{journalEntryId, amountCents, sourceModule?, sourceId?}], matchedBy? }
   */
  @Post('lines/:id/match')
  @Roles('admin', 'accountant')
  confirm(
    @Param('id') id: string,
    @Body()
    body: {
      links: Array<{
        journalEntryId: string;
        amountCents: number;
        sourceModule?: string;
        sourceId?: string;
      }>;
      matchedBy?: string;
    },
  ) {
    return this.svc.confirmMatch(id, body);
  }

  @Post('lines/:id/unmatch')
  @Roles('admin', 'accountant')
  unmatch(@Param('id') id: string) {
    return this.svc.unmatch(id);
  }

  @Post('lines/:id/ignore')
  @Roles('admin', 'accountant')
  ignore(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.svc.ignore(id, body?.reason ?? '');
  }
}
