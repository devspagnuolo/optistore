import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Business-level gate: company must be KYC-approved (and optionally of a given type). */
export async function assertActiveCompany(
  c: PoolClient, companyId: string, allowedTypes?: Array<'supplier' | 'reseller' | 'consumer'>,
) {
  const r = await c.query<{ type: 'supplier' | 'reseller' | 'consumer'; status: string }>(
    'SELECT type, status FROM companies WHERE id = $1', [companyId]);
  const co = r.rows[0];
  if (!co) throw new ForbiddenException();
  if (co.status !== 'active') throw new ForbiddenException('Empresa aguardando aprovação (KYC)');
  if (allowedTypes && !allowedTypes.includes(co.type)) {
    throw new ForbiddenException('Operação não disponível para este tipo de empresa');
  }
  return co;
}
