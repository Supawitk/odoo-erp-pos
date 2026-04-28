import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from './jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.authContext;
  },
);
