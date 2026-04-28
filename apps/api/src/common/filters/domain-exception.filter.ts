import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '../../modules/pos/domain/errors';
import { InventoryDomainError } from '../../modules/inventory/domain/errors';

@Catch(DomainError, InventoryDomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: DomainError | InventoryDomainError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    this.logger.warn(
      `DomainError ${exception.code}: ${exception.message} (${request.method} ${request.url})`,
    );

    const body = {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      error: exception.code,
      message: exception.message,
      timestamp: new Date().toISOString(),
    };

    // Fastify reply
    if (typeof response.status === 'function') {
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).send(body);
    }
    // Express fallback
    return response.code(HttpStatus.UNPROCESSABLE_ENTITY).send(body);
  }
}
