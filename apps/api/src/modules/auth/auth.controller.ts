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
  async register(@Body() body: { email?: string; password?: string; name?: string }) {
    if (!body?.email || !body?.password || !body?.name) {
      throw new BadRequestException('email, password, and name are required');
    }
    return this.auth.register({
      email: body.email,
      password: body.password,
      name: body.name,
    });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: string; password?: string }) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('email and password required');
    }
    return this.auth.login(body.email, body.password);
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
