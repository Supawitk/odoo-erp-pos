import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, Roles } from '../auth/jwt-auth.guard';
import { TierValidationService, type TargetKind } from './tier-validation.service';
import {
  ApprovalAlreadyResolvedError,
  ApprovalForbiddenReviewerError,
  ApprovalNotFoundError,
} from './approvals.errors';
import { and, asc, eq } from 'drizzle-orm';
import { tierDefinitions, type Database } from '@erp/db';
import { Inject } from '@nestjs/common';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

interface AuthedReq {
  authContext?: { userId?: string; role?: string };
  user?: { sub?: string; userId?: string; role?: string };
}

const KINDS: TargetKind[] = ['pos.refund', 'po.confirm', 'accounting.je'];

@Controller('api/approvals')
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  constructor(
    private readonly tier: TierValidationService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  /** List pending reviews scoped to the calling user's reviewer-eligibility. */
  @Get()
  async listPending(@Req() req: AuthedReq) {
    const userId = req.authContext?.userId ?? req.user?.sub ?? req.user?.userId;
    return this.tier.listPending(userId);
  }

  /** List ACTIVE rules so the settings UI can show what's gating what. */
  @Get('definitions')
  async listDefinitions() {
    return this.db
      .select()
      .from(tierDefinitions)
      .orderBy(asc(tierDefinitions.targetKind), asc(tierDefinitions.sequence));
  }

  /** Admin-only: create / update a rule. */
  @Post('definitions')
  @Roles('admin')
  async upsertDefinition(@Body() body: any) {
    if (!body?.name || typeof body.name !== 'string') {
      throw new BadRequestException('name required');
    }
    if (!body?.targetKind || !KINDS.includes(body.targetKind)) {
      throw new BadRequestException(`targetKind must be one of ${KINDS.join(', ')}`);
    }
    const reviewerIds = Array.isArray(body.reviewerIds) ? body.reviewerIds : [];

    if (body.id) {
      const [updated] = await this.db
        .update(tierDefinitions)
        .set({
          name: body.name,
          targetKind: body.targetKind,
          conditionExpr: body.conditionExpr ?? null,
          sequence: Number(body.sequence ?? 10),
          reviewerIds,
          isActive: body.isActive !== false,
          updatedAt: new Date(),
        })
        .where(eq(tierDefinitions.id, body.id))
        .returning();
      return updated;
    }
    const [created] = await this.db
      .insert(tierDefinitions)
      .values({
        name: body.name,
        targetKind: body.targetKind,
        conditionExpr: body.conditionExpr ?? null,
        sequence: Number(body.sequence ?? 10),
        reviewerIds,
        isActive: body.isActive !== false,
      })
      .returning();
    return created;
  }

  @Post('definitions/:id/disable')
  @Roles('admin')
  async disableDefinition(@Param('id') id: string) {
    const [updated] = await this.db
      .update(tierDefinitions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(tierDefinitions.id, id))
      .returning();
    return updated;
  }

  @Post(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body() body: { comment?: string },
    @Req() req: AuthedReq,
  ) {
    const userId = req.authContext?.userId ?? req.user?.sub ?? req.user?.userId;
    if (!userId) throw new BadRequestException('unauthenticated');
    try {
      return await this.tier.approve(id, userId, body?.comment);
    } catch (e) {
      this.translate(e);
      throw e;
    }
  }

  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() body: { comment?: string },
    @Req() req: AuthedReq,
  ) {
    const userId = req.authContext?.userId ?? req.user?.sub ?? req.user?.userId;
    if (!userId) throw new BadRequestException('unauthenticated');
    if (!body?.comment) throw new BadRequestException('reject requires a comment');
    try {
      return await this.tier.reject(id, userId, body.comment);
    } catch (e) {
      this.translate(e);
      throw e;
    }
  }

  @Get('for-target')
  async getForTarget(
    @Query('kind') kind: TargetKind,
    @Query('id') targetId: string,
  ) {
    if (!kind || !KINDS.includes(kind)) {
      throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
    }
    if (!targetId) throw new BadRequestException('id required');
    return this.tier.getReviewsForTargets(kind, [targetId]);
  }

  private translate(e: unknown) {
    if (e instanceof ApprovalNotFoundError) throw new BadRequestException(e.message);
    if (e instanceof ApprovalAlreadyResolvedError) throw new BadRequestException(e.message);
    if (e instanceof ApprovalForbiddenReviewerError) throw new BadRequestException(e.message);
  }
}
