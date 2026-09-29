import { Injectable } from '@nestjs/common';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtTtl: string;
  encryptionKey: string;
  takeRateBps: number;
  paymentWebhookSecret: string;
  platformAdminEmails: string[];
  corsOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing required env var ${k}`);
    return v;
  };
  const jwtSecret = need('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const encryptionKey = need('ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) throw new Error('ENCRYPTION_KEY must be 64 hex chars');
  const webhook = need('PAYMENT_WEBHOOK_SECRET');
  if (webhook.length < 32) throw new Error('PAYMENT_WEBHOOK_SECRET must be at least 32 characters');
  const takeRateBps = Number(env.TAKE_RATE_BPS ?? 500); // placeholder default: business must define
  if (!Number.isInteger(takeRateBps) || takeRateBps < 0 || takeRateBps > 10_000) throw new Error('TAKE_RATE_BPS invalid');
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: need('DATABASE_URL'),
    jwtSecret,
    jwtTtl: env.JWT_TTL ?? '15m',
    encryptionKey,
    takeRateBps,
    paymentWebhookSecret: webhook,
    platformAdminEmails: list(env.PLATFORM_ADMIN_EMAILS).map((e) => e.toLowerCase()),
    corsOrigins: list(env.CORS_ORIGINS),
  };
}

@Injectable()
export class ConfigService {
  readonly cfg: AppConfig = loadConfig();
}
