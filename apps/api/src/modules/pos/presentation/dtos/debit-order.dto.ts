import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DebitLineDto {
  @IsString()
  @Length(1, 200)
  description!: string;

  @IsNumber()
  @Min(0.001)
  qty!: number;

  @IsInt()
  @Min(1)
  unitPriceCents!: number;

  @IsOptional()
  @IsIn(['standard', 'zero_rated', 'exempt'])
  vatCategory?: 'standard' | 'zero_rated' | 'exempt';
}

export class DebitOrderDto {
  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsOptional()
  @IsString()
  approvedBy?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DebitLineDto)
  lines!: DebitLineDto[];
}
