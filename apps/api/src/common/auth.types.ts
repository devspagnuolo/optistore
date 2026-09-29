import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export type MemberRole = 'owner' | 'admin' | 'buyer' | 'seller' | 'finance' | 'viewer';

export interface AuthUser {
  userId: string;
  companyId: string;
  role: MemberRole;
  platformAdmin: boolean;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** RBAC: allowed member roles (owner/admin always pass). */
export const Roles = (...roles: MemberRole[]) => SetMetadata(ROLES, roles);

export const PLATFORM_ADMIN = 'platformAdmin';
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser =>
  ctx.switchToHttp().getRequest().user);
