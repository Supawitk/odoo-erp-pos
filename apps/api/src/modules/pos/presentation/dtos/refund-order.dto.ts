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

  @IsString()
  approvedBy!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RefundLineSelectionDto)
  lines?: RefundLineSelectionDto[];
}
