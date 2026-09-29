import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, MfaCodeDto, RegisterDto } from './auth.dto';
import { AuthUser, CurrentUser, Public } from '../../common/auth.types';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register') register(@Body() dto: RegisterDto) { return this.auth.register(dto); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(200)
  @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto); }

  @Post('mfa/setup') mfaSetup(@CurrentUser() u: AuthUser) { return this.auth.mfaSetup(u); }

  @HttpCode(200)
  @Post('mfa/enable') mfaEnable(@CurrentUser() u: AuthUser, @Body() dto: MfaCodeDto) {
    return this.auth.mfaEnable(u, dto.code);
  }
}
