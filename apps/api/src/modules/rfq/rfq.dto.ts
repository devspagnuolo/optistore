import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class RfqItemDto {
  @IsString() @Length(2, 300) description: string;
  @IsInt() @Min(1) @Max(1_000_000) quantity: number;
  @IsOptional() @IsUUID() variantId?: string;
}

export class CreateRfqDto {
  @IsString() @Length(3, 200) title: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsDateString() deadline?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RfqItemDto)
  items: RfqItemDto[];
  /** Empty/omitted = open RFQ (any active supplier). Otherwise invited-only. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ArrayUnique() @IsUUID('all', { each: true })
  invitedSupplierIds?: string[];
}

export class QuoteItemDto {
  @IsUUID() rfqItemId: string;
  @IsInt() @Min(0) @Max(1_000_000_000) unitPriceCents: number;
}

export class CreateQuoteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => QuoteItemDto)
  items: QuoteItemDto[];
  @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
  @IsOptional() @IsDateString() validUntil?: string;
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
}
