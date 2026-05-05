import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '../../modules/pos/domain/errors';
import { InventoryDomainError } from '../../modules/inventory/domain/errors';
import { ApprovalRequiredError } from '../../modules/approvals/approvals.errors';

@Catch(DomainError, InventoryDomainError, ApprovalRequiredError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(
    exception: DomainError | InventoryDomainError | ApprovalRequiredError,
    host: ArgumentsHost,
  ) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    this.logger.warn(
      `DomainError ${exception.code}: ${exception.message} (${request.method} ${request.url})`,
    );

    const body: Record<string, unknown> = {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      error: exception.code,
      message: exception.message,
      timestamp: new Date().toISOString(),
    };
    // Approval-required carries the pending review ids so the UI can deep-link
    // straight to /approvals?ids=…
    if (exception instanceof ApprovalRequiredError) {
      body.pendingReviewIds = exception.reviewIds;
    }

    // Fastify reply
    if (typeof response.status === 'function') {
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).send(body);
    }
    // Express fallback
    return response.code(HttpStatus.UNPROCESSABLE_ENTITY).send(body);
  }
}
