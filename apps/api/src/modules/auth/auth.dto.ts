import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength, Matches } from 'class-validator';

export class RegisterDto {
  @IsIn(['supplier', 'reseller']) companyType: 'supplier' | 'reseller'; // B2C is out of MVP scope
  @IsString() @Length(2, 200) legalName: string;
  @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @IsString() @Length(14, 18) cnpj: string;
  @IsString() @Length(2, 200) fullName: string;
  @IsEmail() @MaxLength(254) email: string;
  @IsString() @MinLength(10) @MaxLength(128) password: string;
}

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MaxLength(128) password: string;
  @IsOptional() @Matches(/^\d{6}$/) totpCode?: string;
  @IsOptional() @IsUUID() companyId?: string;
}

export class MfaCodeDto {
  @Matches(/^\d{6}$/) code: string;
}
