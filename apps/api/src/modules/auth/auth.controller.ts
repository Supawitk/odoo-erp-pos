import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public, JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { AuthContext } from './jwt-auth.guard';

@Controller('api/auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body()
    body: { email?: string; username?: string; password?: string; name?: string },
  ) {
    if (!body?.password || !body?.name) {
      throw new BadRequestException('password and name are required');
    }
    if (!body.email && !body.username) {
      throw new BadRequestException('Provide an email, a username, or both');
    }
    return this.auth.register({
      email: body.email,
      username: body.username,
      password: body.password,
      name: body.name,
    });
  }

  /**
   * Login by email OR username. The body accepts either:
   *   { identifier: "alice@example.com" | "alice", password: "..." }
   *   or the legacy form  { email: ..., password: ... }
   * to keep backward compatibility for any clients that already POST `email`.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { identifier?: string; email?: string; username?: string; password?: string },
  ) {
    const identifier = body?.identifier ?? body?.email ?? body?.username;
    if (!identifier || !body?.password) {
      throw new BadRequestException('identifier (email or username) and password required');
    }
    return this.auth.login(identifier, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken?: string }) {
    if (!body?.refreshToken) throw new UnauthorizedException('refreshToken required');
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() body: { refreshToken?: string }) {
    return this.auth.logout(body?.refreshToken);
  }

  @Get('me')
  async me(@CurrentUser() ctx: AuthContext) {
    return this.auth.me(ctx.userId);
  }
}
