import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import * as Papa from 'papaparse';
import { ProductsService } from './products.service';
import { Roles } from '../auth/jwt-auth.guard';

@Controller('api/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * CSV bulk product import. Accepts either:
   *   - { csv: "name,sku,...\n..." } — raw text body (web upload reads file → string)
   *   - { rows: [{name,...}, ...] } — pre-parsed rows
   *
   * Returns counts + per-row errors so the UI can show which lines failed.
   */
  @Post('import')
  @Roles('admin', 'manager')
  async importCsv(@Body() body: { csv?: string; rows?: Record<string, string>[] }) {
    let rows: Record<string, string>[] = [];
    if (body.rows) {
      rows = body.rows;
    } else if (body.csv) {
      const parsed = Papa.parse<Record<string, string>>(body.csv.trim(), {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });
      if (parsed.errors.length > 0) {
        throw new BadRequestException({
          error: 'CSV_PARSE_ERROR',
          details: parsed.errors.slice(0, 10),
        });
      }
      rows = parsed.data;
    } else {
      throw new BadRequestException('Provide either `csv` (string) or `rows` (array)');
    }

    if (rows.length === 0) {
      return { inserted: 0, updated: 0, errors: [{ row: 1, reason: 'CSV had no data rows' }] };
    }
    if (rows.length > 5000) {
      throw new BadRequestException('Max 5000 rows per import');
    }
    return this.products.importRows(rows);
  }

  @Post('reindex')
  @HttpCode(200)
  @Roles('admin', 'manager')
  async reindex() {
    return this.products.reindexMeili();
  }

  @Get()
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('category') category?: string,
  ) {
    return this.products.list({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      category,
    });
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.products.search(q ?? '', limit ? parseInt(limit, 10) : undefined);
  }

  @Get('barcode/:code')
  findByBarcode(@Param('code') code: string) {
    return this.products.findByBarcode(code);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.products.findById(id);
  }

  @Post()
  @HttpCode(201)
  @Roles('admin', 'manager')
  create(@Body() body: Parameters<ProductsService['create']>[0]) {
    return this.products.create(body);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(@Param('id') id: string, @Body() body: Parameters<ProductsService['update']>[1]) {
    return this.products.update(id, body);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  deactivate(@Param('id') id: string) {
    return this.products.deactivate(id);
  }
}
