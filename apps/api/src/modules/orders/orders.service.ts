import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthUser } from '../../common/auth.types';
import { calcCommission } from '../../common/money';
import { ConfigService } from '../../common/config';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

interface QuoteRow { id: string; supplier_id: string; total_cents: number }

@Injectable()
export class OrdersService {
  constructor(private db: DatabaseService, private audit: AuditService, private cfg: ConfigService) {}

  /** Called inside the RFQ-accept transaction so quote award + order creation are atomic. */
  async createFromQuote(c: PoolClient, u: AuthUser, quote: QuoteRow) {
    const items = await c.query(
      `SELECT ri.description, ri.variant_id, ri.quantity, qi.unit_price_cents
         FROM rfq_items ri JOIN quote_items qi ON qi.rfq_item_id = ri.id
        WHERE qi.quote_id = $1`, [quote.id]);
    if (!items.rows.length) throw new BadRequestException('Cotação sem itens');
    const bps = this.cfg.cfg.takeRateBps;
    const commission = calcCommission(quote.total_cents, bps);
    const o = await c.query<{ id: string }>(
      `INSERT INTO orders (buyer_id, supplier_id, quote_id, total_cents, commission_cents, take_rate_bps)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [u.companyId, quote.supplier_id, quote.id, quote.total_cents, commission, bps]);
    const orderId = o.rows[0].id;
    for (const it of items.rows) {
      await c.query(
        `INSERT INTO order_items (order_id, description, variant_id, quantity, unit_price_cents) VALUES ($1,$2,$3,$4,$5)`,
        [orderId, it.description, it.variant_id, it.quantity, it.unit_price_cents]);
    }
    await this.audit.record(c, u, 'order.created', 'order', orderId, { quoteId: quote.id, total: quote.total_cents });
    return { id: orderId, totalCents: quote.total_cents, commissionCents: commission, status: 'pending_payment' };
  }

  list(u: AuthUser) {
    return this.db.tx(u, async (c) => {
      const r = await c.query(
        `SELECT id, buyer_id, supplier_id, status, total_cents, commission_cents, created_at, paid_at
           FROM orders ORDER BY created_at DESC LIMIT 50`);
      return r.rows;
    });
  }

  get(u: AuthUser, id: string) {
    return this.db.tx(u, async (c) => {
      const o = await c.query('SELECT * FROM orders WHERE id = $1', [id]);
      if (!o.rows[0]) throw new NotFoundException();
      const items = await c.query(
        'SELECT description, variant_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1', [id]);
      return { ...o.rows[0], items: items.rows };
    });
  }

  /** Supplier: paid -> shipped. */
  ship(u: AuthUser, id: string) {
    return this.transition(u, id, 'supplier_id', 'paid', 'shipped', 'order.shipped');
  }

  /** Buyer: shipped -> delivered. */
  deliver(u: AuthUser, id: string) {
    return this.transition(u, id, 'buyer_id', 'shipped', 'delivered', 'order.delivered');
  }

  private transition(u: AuthUser, id: string, actorCol: 'supplier_id' | 'buyer_id', from: string, to: string, action: string) {
    return this.db.tx(u, async (c) => {
      const r = await c.query(
        `UPDATE orders SET status = $4 WHERE id = $1 AND ${actorCol} = $2 AND status = $3 RETURNING id, status`,
        [id, u.companyId, from, to]);
      if (!r.rows[0]) {
        const ex = await c.query('SELECT status FROM orders WHERE id = $1', [id]);
        if (!ex.rows[0]) throw new NotFoundException();
        throw new ConflictException(`Transição inválida a partir de "${ex.rows[0].status}"`);
      }
      await this.audit.record(c, u, action, 'order', id);
      return r.rows[0];
    });
  }

  /**
   * Payment confirmed by the PSP webhook (signature verified by the controller).
   * Idempotent: order status guard + UNIQUE(ref_type, ref_id) on ledger_transactions.
   *   DR platform:gateway_clearing  total
   *   CR supplier:payable           total - commission
   *   CR platform:revenue           commission
   */
  confirmPayment(orderId: string, gatewayRef: string, amountCents: number) {
    return this.db.tx({ system: true }, async (c) => {
      const o = await c.query(
        'SELECT id, supplier_id, status, total_cents, commission_cents FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      const order = o.rows[0];
      if (!order) throw new NotFoundException();
      if (order.status !== 'pending_payment') {
        if (order.status === 'paid' || order.status === 'shipped' || order.status === 'delivered') {
          return { status: 'already_processed' as const };
        }
        throw new ConflictException(`Pedido em estado "${order.status}"`);
      }
      if (amountCents !== order.total_cents) {
        throw new UnprocessableEntityException('Valor divergente do pedido');
      }
      const tx = await c.query<{ id: string }>(
        `INSERT INTO ledger_transactions (ref_type, ref_id, memo) VALUES ('order_payment', $1, $2)
         ON CONFLICT DO NOTHING RETURNING id`, [orderId, `gateway:${gatewayRef}`]);
      if (!tx.rows[0]) return { status: 'already_processed' as const };

      const clearing = await this.account(c, 'platform:gateway_clearing', null);
      const revenue = await this.account(c, 'platform:revenue', null);
      const payable = await this.account(c, 'supplier:payable', order.supplier_id);
      const payout = order.total_cents - order.commission_cents;
      const entries: Array<[string, number]> = [];
      if (order.total_cents > 0) entries.push([clearing, order.total_cents]);
      if (payout > 0) entries.push([payable, -payout]);
      if (order.commission_cents > 0) entries.push([revenue, -order.commission_cents]);
      for (const [acc, amt] of entries) {
        await c.query('INSERT INTO ledger_entries (tx_id, account_id, amount_cents) VALUES ($1,$2,$3)',
          [tx.rows[0].id, acc, amt]);
      }
      await c.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [orderId]);
      await this.audit.record(c, { companyId: order.supplier_id }, 'order.paid', 'order', orderId, { gatewayRef, amountCents });
      return { status: 'paid' as const };
    });
  }

  private async account(c: PoolClient, code: string, companyId: string | null): Promise<string> {
    await c.query('INSERT INTO ledger_accounts (code, company_id) VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING', [code, companyId]);
    const r = await c.query<{ id: string }>(
      'SELECT id FROM ledger_accounts WHERE code = $1 AND company_id IS NOT DISTINCT FROM $2::uuid', [code, companyId]);
    return r.rows[0].id;
  }
}
