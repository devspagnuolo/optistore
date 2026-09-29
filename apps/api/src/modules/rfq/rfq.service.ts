import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/auth.types';
import { assertActiveCompany } from '../../common/company-guard';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { CreateQuoteDto, CreateRfqDto } from './rfq.dto';

@Injectable()
export class RfqService {
  constructor(private db: DatabaseService, private audit: AuditService, private orders: OrdersService) {}

  create(u: AuthUser, dto: CreateRfqDto) {
    const invited = dto.invitedSupplierIds ?? [];
    return this.db.tx(u, async (c) => {
      await assertActiveCompany(c, u.companyId, ['reseller', 'supplier']);
      if (invited.length) {
        const ok = await c.query(
          `SELECT id FROM companies WHERE id = ANY($1::uuid[]) AND type = 'supplier' AND status = 'active' AND id <> $2`,
          [invited, u.companyId]);
        if (ok.rows.length !== invited.length) throw new BadRequestException('Fornecedor convidado inválido');
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO rfqs (buyer_id, title, notes, deadline, is_open, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [u.companyId, dto.title, dto.notes ?? null, dto.deadline ?? null, invited.length === 0, u.userId]);
      const id = r.rows[0].id;
      for (const it of dto.items) {
        await c.query('INSERT INTO rfq_items (rfq_id, description, quantity, variant_id) VALUES ($1,$2,$3,$4)',
          [id, it.description, it.quantity, it.variantId ?? null]);
      }
      for (const s of invited) {
        await c.query('INSERT INTO rfq_invitations (rfq_id, supplier_id, buyer_id) VALUES ($1,$2,$3)', [id, s, u.companyId]);
      }
      await this.audit.record(c, u, 'rfq.created', 'rfq', id, { items: dto.items.length, invited: invited.length });
      return { id, status: 'open' };
    });
  }

  /** RLS decides visibility: buyers see their RFQs; suppliers see open ones (all, or invited). */
  list(u: AuthUser) {
    return this.db.tx(u, async (c) => {
      const r = await c.query(
        `SELECT r.id, r.buyer_id, co.trade_name AS buyer_name, r.title, r.status, r.is_open, r.deadline, r.created_at
           FROM rfqs r JOIN companies co ON co.id = r.buyer_id
          ORDER BY r.created_at DESC LIMIT 50`);
      return r.rows;
    });
  }

  get(u: AuthUser, id: string) {
    return this.db.tx(u, async (c) => {
      const r = await c.query('SELECT * FROM rfqs WHERE id = $1', [id]);
      if (!r.rows[0]) throw new NotFoundException();
      const items = await c.query(
        'SELECT id, description, quantity, variant_id FROM rfq_items WHERE rfq_id = $1 ORDER BY description', [id]);
      // Buyer sees all quotes (side-by-side comparison, cheapest first); a supplier sees only their own (RLS).
      const quotes = await c.query(
        `SELECT q.id, q.supplier_id, co.trade_name AS supplier_name, q.status, q.total_cents, q.lead_time_days,
                q.valid_until, q.message,
                (SELECT json_agg(json_build_object('rfqItemId', qi.rfq_item_id, 'unitPriceCents', qi.unit_price_cents))
                   FROM quote_items qi WHERE qi.quote_id = q.id) AS items
           FROM quotes q JOIN companies co ON co.id = q.supplier_id
          WHERE q.rfq_id = $1 ORDER BY q.total_cents ASC, q.lead_time_days ASC NULLS LAST`, [id]);
      return { ...r.rows[0], items: items.rows, quotes: quotes.rows };
    });
  }

  createQuote(u: AuthUser, rfqId: string, dto: CreateQuoteDto) {
    return this.db.tx(u, async (c) => {
      await assertActiveCompany(c, u.companyId, ['supplier']);
      const r = await c.query('SELECT id, buyer_id, status, deadline FROM rfqs WHERE id = $1', [rfqId]); // RLS-visible only
      const rfq = r.rows[0];
      if (!rfq) throw new NotFoundException();
      if (rfq.buyer_id === u.companyId) throw new BadRequestException('Não é possível cotar a própria RFQ');
      if (rfq.status !== 'open' || (rfq.deadline && new Date(rfq.deadline) < new Date())) {
        throw new ConflictException('RFQ encerrada');
      }
      const items = await c.query<{ id: string; quantity: number }>('SELECT id, quantity FROM rfq_items WHERE rfq_id = $1', [rfqId]);
      const qtyById = new Map(items.rows.map((i) => [i.id, i.quantity]));
      const seen = new Set<string>();
      let total = 0;
      for (const it of dto.items) {
        const qty = qtyById.get(it.rfqItemId);
        if (qty === undefined || seen.has(it.rfqItemId)) throw new BadRequestException('Itens da cotação não correspondem à RFQ');
        seen.add(it.rfqItemId);
        total += it.unitPriceCents * qty; // total is always computed server-side
      }
      if (seen.size !== qtyById.size) throw new BadRequestException('A cotação deve precificar todos os itens');
      if (!Number.isSafeInteger(total)) throw new BadRequestException('Total inválido');

      const q = await c.query<{ id: string }>(
        `INSERT INTO quotes (rfq_id, supplier_id, total_cents, lead_time_days, valid_until, message)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [rfqId, u.companyId, total, dto.leadTimeDays ?? null, dto.validUntil ?? null, dto.message ?? null]);
      for (const it of dto.items) {
        await c.query('INSERT INTO quote_items (quote_id, rfq_item_id, unit_price_cents) VALUES ($1,$2,$3)',
          [q.rows[0].id, it.rfqItemId, it.unitPriceCents]);
      }
      await this.audit.record(c, u, 'rfq.quote_submitted', 'quote', q.rows[0].id, { rfqId, total });
      return { id: q.rows[0].id, totalCents: total };
    });
  }

  /** Buyer awards a quote: locks RFQ + quote, rejects the rest, creates the order — all atomically. */
  accept(u: AuthUser, rfqId: string, quoteId: string) {
    return this.db.tx(u, async (c) => {
      await assertActiveCompany(c, u.companyId);
      const r = await c.query('SELECT id, status FROM rfqs WHERE id = $1 AND buyer_id = $2 FOR UPDATE', [rfqId, u.companyId]);
      if (!r.rows[0]) throw new NotFoundException();
      if (r.rows[0].status !== 'open') throw new ConflictException('RFQ já encerrada');
      const q = await c.query(
        'SELECT id, supplier_id, total_cents, status, valid_until FROM quotes WHERE id = $1 AND rfq_id = $2 FOR UPDATE',
        [quoteId, rfqId]);
      const quote = q.rows[0];
      if (!quote) throw new NotFoundException();
      if (quote.status !== 'submitted') throw new ConflictException('Cotação não está mais disponível');
      if (quote.valid_until && new Date(quote.valid_until) < new Date()) throw new ConflictException('Cotação expirada');

      await c.query(`UPDATE quotes SET status = 'accepted' WHERE id = $1`, [quoteId]);
      await c.query(`UPDATE quotes SET status = 'rejected' WHERE rfq_id = $1 AND id <> $2 AND status = 'submitted'`, [rfqId, quoteId]);
      await c.query(`UPDATE rfqs SET status = 'awarded' WHERE id = $1`, [rfqId]);
      const order = await this.orders.createFromQuote(c, u, quote);
      await this.audit.record(c, u, 'rfq.awarded', 'rfq', rfqId, { quoteId, orderId: order.id });
      return order;
    });
  }
}
