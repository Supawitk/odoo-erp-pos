import { IsArray, IsInt, IsOptional, IsString, Length, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class RefundLineSelectionDto {
  @IsInt()
  @Min(0)
  lineIndex!: number;

  @IsInt()
  @Min(1)
  qty!: number;
}

export class RefundOrderDto {
  @IsString()
  @Length(3, 500)
  reason!: string;

  /**
   * Manager / supervisor user-id who pre-approves the refund. When omitted,
   * the tier-validation gate may block and return 422 APPROVAL_REQUIRED with
   * pendingReviewIds for the UI to surface.
   */
  @IsString()
  @IsOptional()
  approvedBy?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RefundLineSelectionDto)
  lines?: RefundLineSelectionDto[];
}
