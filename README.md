# OptiStore — Fase 1 (fundação do MVP B2B)

Monolito modular em **NestJS + PostgreSQL** com isolamento multi-tenant por **Row-Level Security**.

## O que já está implementado

| Módulo | Entregas |
|---|---|
| **Identidade** | Cadastro de empresa (CNPJ validado por dígito verificador), login com **Argon2id**, **MFA TOTP** (segredo cifrado AES-256-GCM), bloqueio após 5 falhas, JWT 15 min, RBAC por papel |
| **Admin Master (fatia KYC)** | Fila de aprovação e suspensão de empresas; claim de admin exige e-mail permitido **e** MFA ativo |
| **Catálogo** | Produtos/variantes, preço atacado/varejo, **MOQ**, faixas de preço, publicação, busca full-text PT-BR + fuzzy (trigram) |
| **Estoque (ERP-lite)** | Baseado em **movimentações** (nunca sobrescreve saldo), trava anti-corrida, bloqueio de saldo negativo |
| **RFQ** | RFQ aberta ou por convite, cotações com **total calculado no servidor**, comparação lado a lado (menor preço primeiro), aceite atômico gera pedido |
| **Pedidos + financeiro** | Comissão em aritmética inteira (BigInt), webhook de pagamento **assinado (HMAC)** e idempotente, **ledger de dupla entrada** (trigger rejeita transação desbalanceada) |
| **Auditoria** | Log append-only com **hash encadeado** (SHA-256), gravado na mesma transação da mudança |
| **Plataforma** | Helmet, rate limiting (login 10/min, registro 5/min), validação estrita de DTO (whitelist), filtro que não vaza erros SQL, Docker, CI |

## Rodando

```bash
cp .env.example .env            # gere JWT_SECRET, ENCRYPTION_KEY (openssl rand -hex 32), PAYMENT_WEBHOOK_SECRET
docker compose up -d db         # aplica db/migrations/001_init.sql no primeiro boot
cd apps/api && npm install && npm run start:dev
npm test                        # testes unitários do domínio
```

## Fluxo de ponta a ponta (curl)

```bash
API=http://localhost:3000/v1
# 1. Cadastros (CNPJs válidos de teste: 11222333000181, 11444777000161)
curl -sX POST $API/auth/register -H 'content-type: application/json' -d '{"companyType":"supplier","legalName":"Lentes SA","cnpj":"11222333000181","fullName":"Ana","email":"ana@lentes.com","password":"senha-forte-123"}'
curl -sX POST $API/auth/register -H 'content-type: application/json' -d '{"companyType":"reseller","legalName":"Otica Vista","cnpj":"11444777000161","fullName":"Beto","email":"beto@vista.com","password":"senha-forte-123"}'
# 2. Aprovar KYC das duas empresas (admin: e-mail em PLATFORM_ADMIN_EMAILS + MFA ativo)
#    PATCH $API/admin/companies/:id/status  {"status":"active"}
# 3. Fornecedor: POST /catalog/products -> PATCH /catalog/products/:id/publish
# 4. Ótica: POST /rfqs -> Fornecedor: POST /rfqs/:id/quotes -> Ótica: POST /rfqs/:id/quotes/:quoteId/accept  (gera pedido)
# 5. PSP confirma pagamento (POST /webhooks/payments, header x-signature = HMAC-SHA256 hex do corpo bruto)
# 6. Fornecedor: PATCH /orders/:id/ship -> Ótica: PATCH /orders/:id/deliver
```

## Estado de verificação (honesto)

- **Executado e passando:** 6 testes unitários do domínio (comissão, faixas de preço, cadeia de hash + detecção de adulteração, AES-256-GCM, CNPJ).
- **Não executado neste ambiente** (sem rede e sem PostgreSQL): `npm install`/build do NestJS, a migration e os fluxos HTTP. Revisei o SQL e o TypeScript manualmente e corrigi 3 falhas de RLS durante a revisão (recursão de políticas, vazamento de RFQ privada, política de UPDATE de pedidos), mas **o primeiro `npm run build` e o job de CI podem revelar erros de compilação ou de SQL**. O CI aplica a migration em um Postgres real e roda `db/tests/rls_smoke.sql` (isolamento entre tenants, ledger balanceado, auditoria imutável).

## Limitações conhecidas e próximos passos

1. **Sem refresh token / logout / revogação** — JWT curto apenas. Próximo: refresh rotativo + lista de revogação (Redis).
2. **Provedor de pagamento não escolhido** — o webhook define o contrato; falta a criação da cobrança/split no PSP e o repasse ao fornecedor.
3. **Trava global da cadeia de auditoria** serializa transações que auditam. Suficiente para o MVP; migrar para outbox assíncrono em escala.
4. **Reservas de estoque** (`stock_reservations`) existem no schema mas ainda não são usadas no aceite da RFQ; a saída de estoque no envio também está pendente.
5. **Taxa de comissão** é um placeholder (`TAKE_RATE_BPS`); a política comercial (por plano, categoria) precisa ser definida.
6. **Receitas/dados de saúde (LGPD), KYC real (consulta de CNPJ), importação de catálogo por planilha, upload S3, busca dedicada, OpenTelemetry, Redis/RabbitMQ** — planejados, não implementados nesta fatia.
7. **Frontend (Next.js)** — não iniciado; a API é o contrato.
8. Defesa em profundidade: RLS restringe por linha, mas não por coluna (ex.: comprador poderia alterar `total_cents` de uma cotação via SQL direto). Hoje só a API altera; avaliar `GRANT UPDATE (coluna)`.
