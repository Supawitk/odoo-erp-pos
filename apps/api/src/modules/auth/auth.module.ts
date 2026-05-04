import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SeedAdminService } from './seed-admin.service';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    UsersService,
    JwtAuthGuard,
    SeedAdminService,
    RefreshTokenCleanupService,
  ],
  exports: [
    AuthService,
    UsersService,
    JwtAuthGuard,
    JwtModule,
    RefreshTokenCleanupService,
  ],
})
export class AuthModule {}
