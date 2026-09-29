import { ConflictException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { ConfigService } from '../../common/config';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { decrypt, encrypt } from '../../common/crypto';
import { isValidCnpj, normalizeCnpj } from '../../common/cnpj';
import { BadRequestException } from '@nestjs/common';
import { LoginDto, RegisterDto } from './auth.dto';
import { AuthUser } from '../../common/auth.types';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const GENERIC_ERROR = 'Credenciais inválidas';

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    private db: DatabaseService, private cfg: ConfigService,
    private jwt: JwtService, private audit: AuditService,
  ) {}

  async register(dto: RegisterDto) {
    const cnpj = normalizeCnpj(dto.cnpj);
    if (!isValidCnpj(cnpj)) throw new BadRequestException('CNPJ inválido');
    const hash = await argon2.hash(dto.password, { type: argon2.argon2id });
    try {
      return await this.db.tx({ system: true }, async (c) => {
        const co = await c.query<{ id: string }>(
          `INSERT INTO companies (type, legal_name, trade_name, cnpj) VALUES ($1,$2,$3,$4) RETURNING id`,
          [dto.companyType, dto.legalName, dto.tradeName ?? null, cnpj]);
        const us = await c.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
          [dto.email.toLowerCase(), hash, dto.fullName]);
        const companyId = co.rows[0].id, userId = us.rows[0].id;
        await c.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1,$2,'owner')`, [userId, companyId]);
        await this.audit.record(c, { companyId, userId }, 'auth.register', 'company', companyId, { type: dto.companyType });
        return { companyId, userId, status: 'pending_kyc' as const };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('E-mail ou CNPJ já cadastrado');
      throw e;
    }
  }

  async login(dto: LoginDto) {
    const email = dto.email.toLowerCase();
    // The tx returns a verdict instead of throwing so the failure counter is committed.
    const result = await this.db.tx({ system: true }, async (c) => {
      const r = await c.query(
        `SELECT id, password_hash, mfa_enabled, mfa_secret_enc, failed_logins, locked_until
           FROM users WHERE email = $1 FOR UPDATE`, [email]);
      const u = r.rows[0];
      if (!u) {
        // Equalize timing to reduce account enumeration.
        this.dummyHash ??= argon2.hash('optistore-dummy', { type: argon2.argon2id });
        await argon2.verify(await this.dummyHash, dto.password).catch(() => false);
        return { ok: false as const, locked: false };
      }
      if (u.locked_until && new Date(u.locked_until) > new Date()) return { ok: false as const, locked: true };

      const pwOk = await argon2.verify(u.password_hash, dto.password).catch(() => false);
      let mfaOk = true;
      if (u.mfa_enabled) {
        mfaOk = !!dto.totpCode && authenticator.check(dto.totpCode, decrypt(u.mfa_secret_enc, this.cfg.cfg.encryptionKey));
      }
      if (!pwOk || !mfaOk) {
        const fails = u.failed_logins + 1;
        await c.query(
          `UPDATE users SET failed_logins = $2,
             locked_until = CASE WHEN $2 >= $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
           WHERE id = $1`, [u.id, fails, MAX_FAILS, LOCK_MINUTES]);
        await this.audit.record(c, { userId: u.id }, 'auth.login_failed', 'user', u.id, { mfa: u.mfa_enabled });
        return { ok: false as const, locked: false };
      }

      const m = await c.query(
        `SELECT company_id, role FROM memberships
          WHERE user_id = $1 AND ($2::uuid IS NULL OR company_id = $2::uuid)
          ORDER BY company_id LIMIT 1`, [u.id, dto.companyId ?? null]);
      if (!m.rows[0]) return { ok: false as const, locked: false };

      await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
      await this.audit.record(c, { companyId: m.rows[0].company_id, userId: u.id }, 'auth.login', 'user', u.id);
      return {
        ok: true as const,
        userId: u.id as string,
        companyId: m.rows[0].company_id as string,
        role: m.rows[0].role,
        mfaEnabled: u.mfa_enabled as boolean,
      };
    });

    if (!result.ok) {
      if (result.locked) throw new HttpException('Conta temporariamente bloqueada. Tente mais tarde.', HttpStatus.TOO_MANY_REQUESTS);
      throw new UnauthorizedException(GENERIC_ERROR);
    }
    // Platform-admin claim requires the allow-listed e-mail AND an enrolled MFA device.
    const platformAdmin = this.cfg.cfg.platformAdminEmails.includes(email) && result.mfaEnabled;
    const accessToken = await this.jwt.signAsync(
      { sub: result.userId, cid: result.companyId, role: result.role, adm: platformAdmin || undefined });
    return { accessToken, mfaEnabled: result.mfaEnabled };
  }

  /** Step 1: generate a secret (stored encrypted, not yet active). */
  async mfaSetup(u: AuthUser) {
    const secret = authenticator.generateSecret();
    return this.db.tx({ system: true }, async (c) => {
      const r = await c.query<{ email: string; mfa_enabled: boolean }>(
        'SELECT email, mfa_enabled FROM users WHERE id = $1', [u.userId]);
      if (r.rows[0]?.mfa_enabled) throw new ConflictException('MFA já ativado');
      await c.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1',
        [u.userId, encrypt(secret, this.cfg.cfg.encryptionKey)]);
      return { secret, otpauthUrl: authenticator.keyuri(r.rows[0].email, 'OptiStore', secret) };
    });
  }

  /** Step 2: prove possession of the device to activate MFA. */
  async mfaEnable(u: AuthUser, code: string) {
    return this.db.tx({ system: true }, async (c) => {
      const r = await c.query('SELECT mfa_secret_enc FROM users WHERE id = $1 FOR UPDATE', [u.userId]);
      const enc = r.rows[0]?.mfa_secret_enc;
      if (!enc || !authenticator.check(code, decrypt(enc, this.cfg.cfg.encryptionKey))) {
        throw new BadRequestException('Código inválido');
      }
      await c.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [u.userId]);
      await this.audit.record(c, { companyId: u.companyId, userId: u.userId }, 'auth.mfa_enabled', 'user', u.userId);
      return { mfaEnabled: true };
    });
  }
}
