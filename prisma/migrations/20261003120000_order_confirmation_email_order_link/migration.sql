-- Adds the {order_link} line to the platform-wide "order-confirmation" email
-- templates (tenant_id IS NULL), so customers get a link back to their order
-- page. prisma/seed.ts only creates missing templates and never updates them,
-- so existing deployments need this. Each row is only touched while it still
-- holds the original seeded text: a template a Super Admin already edited is
-- left as it is, and tenants' own overrides are never touched.

-- email_templates is under FORCE ROW LEVEL SECURITY and its policy only lets
-- tenant_id IS NULL rows through USING, not WITH CHECK, so updating the
-- platform rows needs the bypass (transaction-local).
SELECT set_config('app.bypass_rls', 'on', true);

UPDATE "email_templates"
SET "updated_at" = NOW(), "body" = E'Hola {customer_name},\n\n¡Gracias por tu pedido en {store_name}!\n\nPedido: {order_no}\nTotal: {grand_total}\n\nVer tu pedido: {order_link}\n\nTe contactaremos sobre la entrega.'
WHERE "tenant_id" IS NULL
  AND "key" = 'order-confirmation'
  AND "locale" = 'es'
  AND "body" = E'Hola {customer_name},\n\n¡Gracias por tu pedido en {store_name}!\n\nPedido: {order_no}\nTotal: {grand_total}\n\nTe contactaremos sobre la entrega.';

UPDATE "email_templates"
SET "updated_at" = NOW(), "body" = E'Hi {customer_name},\n\nThanks for your order at {store_name}!\n\nOrder: {order_no}\nTotal: {grand_total}\n\nSee your order: {order_link}\n\nWe will be in touch about delivery.'
WHERE "tenant_id" IS NULL
  AND "key" = 'order-confirmation'
  AND "locale" = 'en'
  AND "body" = E'Hi {customer_name},\n\nThanks for your order at {store_name}!\n\nOrder: {order_no}\nTotal: {grand_total}\n\nWe will be in touch about delivery.';
