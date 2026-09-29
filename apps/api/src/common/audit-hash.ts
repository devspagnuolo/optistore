import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  at: string; // ISO timestamp
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function computeAuditHash(prevHash: string, entry: AuditEntry): string {
  return createHash('sha256').update(prevHash).update('|').update(canonicalize(entry)).digest('hex');
}

export interface StoredAudit extends AuditEntry { prevHash: string; hash: string }

/** Returns the index of the first broken link, or -1 if the chain is intact. */
export function verifyChain(rows: StoredAudit[], startPrev = GENESIS_HASH): number {
  let prev = startPrev;
  for (let i = 0; i < rows.length; i++) {
    const { prevHash, hash, ...entry } = rows[i];
    if (prevHash !== prev || computeAuditHash(prev, entry) !== hash) return i;
    prev = hash;
  }
  return -1;
}
