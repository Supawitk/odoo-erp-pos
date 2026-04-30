import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { auditEvents, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Audit log of every successful mutation. Identity comes from the JWT
 * subject set by JwtAuthGuard onto `req.authContext`. The X-User-Id header
 * is honoured ONLY as a fallback for dev/test calls that bypass auth (e.g.
 * the @Public() health route). In production every mutation carries a JWT
 * because the guard is global.
 *
 * Skip rules:
 *   - Skips GET / HEAD / OPTIONS (read-only)
 *   - Skips paths in SKIP_PATHS (high-volume, low-value)
 *   - Truncates payloads to 8 KB so the audit table stays manageable
 */
const SKIP_PATHS = [
  '/health',
  '/api/products/search', // high frequency
];

const MAX_PAYLOAD_BYTES = 8 * 1024;

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<any>();
    const method: string = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next.handle();

    const url: string = req.url ?? req.routerPath ?? '';
    if (SKIP_PATHS.some((p) => url.startsWith(p))) return next.handle();

    // Identity: prefer JWT-derived (set by JwtAuthGuard), fall back to header
    // only when the route is @Public() and no token was present.
    const auctx = req.authContext as
      | { userId?: string; email?: string | null; role?: string }
      | undefined;
    const userId =
      auctx?.userId ?? req.headers?.['x-user-id'] ?? req.headers?.['X-User-Id'] ?? null;
    const userEmail =
      auctx?.email ?? req.headers?.['x-user-email'] ?? req.headers?.['X-User-Email'] ?? null;
    const ipAddress: string =
      req.ip ?? req.headers?.['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown';

    const requestPayload = this.truncate(req.body);

    return next.handle().pipe(
      tap({
        next: (response) => {
          // Fire-and-forget: don't block the response on audit insert
          this.write(method, url, response, requestPayload, userId, userEmail, ipAddress).catch(
            (err) => this.logger.warn(`audit write failed: ${err.message}`),
          );
        },
      }),
    );
  }

  private async write(
    method: string,
    url: string,
    response: unknown,
    requestPayload: any,
    userId: string | null,
    userEmail: string | null,
    ipAddress: string,
  ) {
    // Aggregate ID: try common shapes — { id }, { orderId }, { grnId }, { sessionId }
    const r: any = response ?? {};
    const aggregateId: string =
      r.id ?? r.orderId ?? r.grnId ?? r.sessionId ?? r.poId ?? r.moveId ?? 'n/a';

    // Aggregate type: from URL prefix (e.g. /api/pos/orders → pos.orders)
    const aggregateType = this.classifyUrl(url);

    const eventType = `${method} ${url.split('?')[0]}`;
    const responsePayload = this.truncate(response);

    // Validate userId is a UUID — header is dev-mode only; if malformed, drop it.
    const userIdValid =
      typeof userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
        ? userId
        : null;

    await this.db.insert(auditEvents).values({
      aggregateType,
      aggregateId: String(aggregateId),
      eventType,
      eventData: { request: requestPayload, response: responsePayload },
      userId: userIdValid,
      userEmail: typeof userEmail === 'string' ? userEmail : null,
      ipAddress: String(ipAddress).slice(0, 64),
    });
  }

  private classifyUrl(url: string): string {
    // /api/pos/orders/:id → pos.orders ; /api/inventory/cycle-counts/:id/post → inventory.cycle-counts
    const m = url.match(/\/api\/([a-z-]+)\/([a-z-]+)/i);
    if (m) return `${m[1]}.${m[2]}`;
    return url.startsWith('/api/') ? url.split('/').slice(0, 3).join('.') : 'unknown';
  }

  private truncate(payload: unknown): any {
    if (payload == null) return null;
    let str: string;
    try {
      str = JSON.stringify(payload);
    } catch {
      return { _unserializable: true };
    }
    if (str.length <= MAX_PAYLOAD_BYTES) return payload;
    return { _truncated: true, _bytes: str.length, sample: str.slice(0, MAX_PAYLOAD_BYTES) };
  }
}
