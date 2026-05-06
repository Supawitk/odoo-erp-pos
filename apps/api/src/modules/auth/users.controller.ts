import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard, Roles } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { AuthContext } from './jwt-auth.guard';

@Controller('api/users')
@UseGuards(JwtAuthGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list() {
    return this.users.list();
  }

  @Patch(':id/role')
  async setRole(
    @Param('id') id: string,
    @Body() body: { role?: string },
    @CurrentUser() me: AuthContext,
  ) {
    if (!body?.role) throw new BadRequestException('role required');
    if (id === me.userId && body.role !== 'admin') {
      // Prevent admin from accidentally locking themselves out of /api/users
      throw new ForbiddenException('You cannot demote your own admin account');
    }
    return this.users.setRole(id, body.role);
  }

  @Patch(':id/active')
  async setActive(
    @Param('id') id: string,
    @Body() body: { isActive?: boolean },
    @CurrentUser() me: AuthContext,
  ) {
    if (typeof body?.isActive !== 'boolean') {
      throw new BadRequestException('isActive boolean required');
    }
    if (id === me.userId && body.isActive === false) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }
    return this.users.setActive(id, body.isActive);
  }

  @Patch(':id/password')
  async resetPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    if (!body?.password) throw new BadRequestException('password required');
    return this.users.resetPassword(id, body.password);
  }

  @Patch(':id/branch')
  async setBranch(
    @Param('id') id: string,
    @Body() body: { branchCode?: string | null },
  ) {
    return this.users.setBranch(id, body?.branchCode ?? null);
  }
}
