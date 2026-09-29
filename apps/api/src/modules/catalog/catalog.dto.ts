import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString,
  Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class TierDto {
  @IsInt() @Min(1) minQty: number;
  @IsInt() @Min(0) @Max(1_000_000_000) priceCents: number;
}

export class VariantDto {
  @IsString() @Length(1, 64) sku: string;
  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
  @IsInt() @Min(0) @Max(1_000_000_000) wholesalePriceCents: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) retailPriceCents?: number;
  @IsOptional() @IsInt() @Min(1) moq?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => TierDto) tiers?: TierDto[];
}

export class CreateProductDto {
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @IsString() @MaxLength(100) brand?: string;
  @IsString() @Length(2, 50) category: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => VariantDto)
  variants: VariantDto[];
}
