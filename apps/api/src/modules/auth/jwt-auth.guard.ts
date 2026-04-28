import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from './auth.service';

const ROLES_KEY = 'auth:roles';
const PUBLIC_KEY = 'auth:public';

/** `@Public()` route — skip auth entirely. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** `@Roles('admin', 'manager')` — restrict route to those roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest();
    if (isPublic) return true;

    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    const m = auth.match(/^Bearer (.+)$/i);
    if (!m) throw new UnauthorizedException('Missing bearer token');
    const token = m[1];
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException('Token invalid or expired');
    }
    const auctx: AuthContext = {
      userId: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };
    req.authContext = auctx;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && required.length > 0) {
      if (!required.includes(auctx.role)) {
        throw new ForbiddenException(
          `This action requires one of: ${required.join(', ')}. Your role: ${auctx.role}`,
        );
      }
    }
    return true;
  }
}
