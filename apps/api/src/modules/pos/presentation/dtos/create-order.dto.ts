import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OrderLineDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @Min(1)
  qty!: number;

  @IsInt()
  @Min(0)
  unitPriceCents!: number;

  @IsOptional()
  @IsEnum(['standard', 'zero_rated', 'exempt'])
  vatCategory?: 'standard' | 'zero_rated' | 'exempt';

  @IsOptional()
  @IsInt()
  @Min(0)
  discountCents?: number;
}

export class PaymentDetailsDto {
  @IsEnum(['cash', 'card', 'split', 'promptpay'])
  method!: 'cash' | 'card' | 'split' | 'promptpay';

  @IsInt()
  @Min(0)
  amountCents!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  tenderedCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  changeCents?: number;

  @IsOptional()
  @IsString()
  cardLast4?: string;

  @IsOptional()
  @IsString()
  promptpaySlipSsid?: string; // filled in by slip-verify webhook
}

export class BuyerDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @Matches(/^\d[\d\s\-]{11,16}$/, { message: 'TIN must be 13 digits (may contain separators)' })
  tin?: string;

  @IsOptional()
  @Matches(/^\d{1,5}$/, { message: 'branch must be 1-5 digits' })
  branch?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  address?: string;
}

export class CreateOrderDto {
  @IsUUID()
  offlineId!: string;

  @IsUUID()
  sessionId!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  cartDiscountCents?: number; // order-level discount, pro-rated across lines

  @IsString()
  currency!: string;

  @IsEnum(['inclusive', 'exclusive'])
  @IsOptional()
  vatMode?: 'inclusive' | 'exclusive';

  @ValidateNested()
  @Type(() => PaymentDetailsDto)
  payment!: PaymentDetailsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerDto)
  buyer?: BuyerDto;

  @IsOptional()
  @IsString()
  iPadDeviceId?: string;
}
