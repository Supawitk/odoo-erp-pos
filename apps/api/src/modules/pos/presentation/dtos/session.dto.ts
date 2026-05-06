import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class OpenSessionDto {
  @IsUUID()
  userId!: string;

  @IsInt()
  @Min(0)
  openingBalanceCents!: number;

  @IsOptional()
  @IsString()
  deviceId?: string;

  /** 🇹🇭 §86/4 branch code. Default '00000' = head office (สำนักงานใหญ่). */
  @IsOptional()
  @IsString()
  branchCode?: string;
}

export class CloseSessionDto {
  @IsInt()
  @Min(0)
  countedBalanceCents!: number;

  @IsOptional()
  @IsUUID()
  varianceApprovedBy?: string;
}
