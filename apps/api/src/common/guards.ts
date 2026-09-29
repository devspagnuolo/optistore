import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthUser, IS_PUBLIC, PLATFORM_ADMIN, ROLES, MemberRole } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; cid: string; role: MemberRole; adm?: boolean }>(
        header.slice(7), { algorithms: ['HS256'] });
      req.user = { userId: p.sub, companyId: p.cid, role: p.role, platformAdmin: p.adm === true } satisfies AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) return true; // public route
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, targets) && !user.platformAdmin) {
      throw new ForbiddenException();
    }
    const roles = this.reflector.getAllAndOverride<MemberRole[]>(ROLES, targets);
    if (!roles?.length) return true;
    if (user.role === 'owner' || user.role === 'admin' || roles.includes(user.role)) return true;
    throw new ForbiddenException('Permissão insuficiente');
  }
}
