import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/auth.types';
import { assertActiveCompany } from '../../common/company-guard';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { CreateProductDto } from './catalog.dto';

@Injectable()
export class CatalogService {
  constructor(private db: DatabaseService, private audit: AuditService) {}

  createProduct(u: AuthUser, dto: CreateProductDto) {
    return this.db.tx(u, async (c) => {
      await assertActiveCompany(c, u.companyId, ['supplier']);
      const p = await c.query<{ id: string }>(
        `INSERT INTO products (supplier_id, name, brand, category, description, attributes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [u.companyId, dto.name, dto.brand ?? null, dto.category, dto.description ?? null, JSON.stringify(dto.attributes ?? {})]);
      const productId = p.rows[0].id;
      for (const v of dto.variants) {
        const vr = await c.query<{ id: string }>(
          `INSERT INTO product_variants (product_id, supplier_id, sku, attributes, wholesale_price_cents, retail_price_cents, moq)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [productId, u.companyId, v.sku, JSON.stringify(v.attributes ?? {}), v.wholesalePriceCents,
           v.retailPriceCents ?? null, v.moq ?? 1]);
        for (const t of v.tiers ?? []) {
          await c.query('INSERT INTO price_tiers (variant_id, min_qty, price_cents) VALUES ($1,$2,$3)',
            [vr.rows[0].id, t.minQty, t.priceCents]);
        }
      }
      await this.audit.record(c, u, 'catalog.product_created', 'product', productId, { variants: dto.variants.length });
      return { id: productId, status: 'draft' };
    });
  }

  publish(u: AuthUser, id: string) {
    return this.db.tx(u, async (c) => {
      await assertActiveCompany(c, u.companyId, ['supplier']);
      const r = await c.query(
        `UPDATE products SET status = 'published' WHERE id = $1 AND supplier_id = $2 RETURNING id, status`,
        [id, u.companyId]);
      if (!r.rows[0]) throw new NotFoundException();
      await this.audit.record(c, u, 'catalog.product_published', 'product', id);
      return r.rows[0];
    });
  }

  search(u: AuthUser, q: string | undefined, category: string | undefined, page: number, pageSize: number) {
    const limit = Math.min(Math.max(pageSize, 1), 50);
    const offset = (Math.max(page, 1) - 1) * limit;
    const term = q?.trim() || null;
    return this.db.tx(u, async (c) => {
      const r = await c.query(
        `SELECT p.id, p.name, p.brand, p.category, p.supplier_id, co.trade_name AS supplier_name,
                MIN(v.wholesale_price_cents) AS min_wholesale_cents, MIN(v.moq) AS min_moq
           FROM products p
           JOIN product_variants v ON v.product_id = p.id
           JOIN companies co ON co.id = p.supplier_id
          WHERE p.status = 'published'
            AND ($1::text IS NULL
                 OR to_tsvector('portuguese', coalesce(p.name,'') || ' ' || coalesce(p.brand,'') || ' ' || coalesce(p.description,''))
                    @@ websearch_to_tsquery('portuguese', $1)
                 OR p.name % $1)
            AND ($2::text IS NULL OR p.category = $2)
          GROUP BY p.id, co.id
          ORDER BY CASE WHEN $1::text IS NULL THEN 0 ELSE similarity(p.name, $1) END DESC, p.created_at DESC
          LIMIT $3 OFFSET $4`,
        [term, category ?? null, limit, offset]);
      return { page, pageSize: limit, items: r.rows };
    });
  }

  get(u: AuthUser, id: string) {
    return this.db.tx(u, async (c) => {
      const p = await c.query(
        `SELECT p.*, co.trade_name AS supplier_name FROM products p JOIN companies co ON co.id = p.supplier_id
          WHERE p.id = $1`, [id]);
      if (!p.rows[0]) throw new NotFoundException();
      const v = await c.query(
        `SELECT v.id, v.sku, v.attributes, v.wholesale_price_cents, v.retail_price_cents, v.moq,
                COALESCE((SELECT json_agg(json_build_object('minQty', t.min_qty, 'priceCents', t.price_cents) ORDER BY t.min_qty)
                            FROM price_tiers t WHERE t.variant_id = v.id), '[]') AS tiers
           FROM product_variants v WHERE v.product_id = $1 ORDER BY v.sku`, [id]);
      return { ...p.rows[0], variants: v.rows };
    });
  }
}
