-- PayPal as a payment provider and digital products delivered by email.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block together with statements that
-- use the new value; nothing here uses the new values, so Prisma's per-migration transaction is fine.

-- AlterEnum
ALTER TYPE "FulfillmentMethod" ADD VALUE 'PAYPAL';
ALTER TYPE "PaymentStatus" ADD VALUE 'DISPUTED';
ALTER TYPE "PaymentProvider" ADD VALUE 'PAYPAL';

-- CreateEnum
CREATE TYPE "CatalogType" AS ENUM ('PHYSICAL', 'DIGITAL');
CREATE TYPE "DigitalDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'REVOKED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "catalog_type" "CatalogType" NOT NULL DEFAULT 'PHYSICAL';
ALTER TABLE "orders" ADD COLUMN "paypal_order_id" TEXT,
ADD COLUMN "paypal_capture_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_paypal_order_id_key" ON "orders"("paypal_order_id");
CREATE UNIQUE INDEX "orders_paypal_capture_id_key" ON "orders"("paypal_capture_id");

-- CreateTable
CREATE TABLE "digital_assets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "digital_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "digital_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "DigitalDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "digital_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "download_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_downloads" INTEGER NOT NULL,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "download_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_price_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_price_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "digital_assets_tenant_id_product_id_idx" ON "digital_assets"("tenant_id", "product_id");
CREATE UNIQUE INDEX "digital_deliveries_order_id_key" ON "digital_deliveries"("order_id");
CREATE INDEX "digital_deliveries_tenant_id_status_idx" ON "digital_deliveries"("tenant_id", "status");
CREATE UNIQUE INDEX "download_grants_token_hash_key" ON "download_grants"("token_hash");
CREATE INDEX "download_grants_tenant_id_idx" ON "download_grants"("tenant_id");
CREATE INDEX "download_grants_delivery_id_idx" ON "download_grants"("delivery_id");
CREATE INDEX "product_price_schedules_tenant_id_idx" ON "product_price_schedules"("tenant_id");
CREATE UNIQUE INDEX "product_price_schedules_product_id_effective_from_key" ON "product_price_schedules"("product_id", "effective_from");

-- AddForeignKey
ALTER TABLE "digital_assets" ADD CONSTRAINT "digital_assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_deliveries" ADD CONSTRAINT "digital_deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "digital_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "digital_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_price_schedules" ADD CONSTRAINT "product_price_schedules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security: every new table carries tenant_id and uses the direct-column policy
-- (same shape as 20260927173503_add_mobile_refresh_tokens, with the nullif guard on the cast).
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['digital_assets', 'digital_deliveries', 'download_grants', 'product_price_schedules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid OR current_setting(''app.bypass_rls'', true) = ''on'')
         WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid OR current_setting(''app.bypass_rls'', true) = ''on'')',
      tbl
    );
  END LOOP;
END $$;

-- Platform-wide default "digital-delivery" email (tenant_id IS NULL). prisma/seed.ts only creates
-- missing templates, but existing deployments are not re-seeded, so insert them here. Inserting
-- platform rows needs the transaction-local RLS bypass (see 20261003120000_order_confirmation_email_order_link).
SELECT set_config('app.bypass_rls', 'on', true);

INSERT INTO "email_templates" ("id", "tenant_id", "key", "locale", "subject", "body", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), NULL, 'digital-delivery', v.locale, v.subject, v.body, true, NOW(), NOW()
FROM (VALUES
  ('en', 'Your downloads from {store_name} — order {order_no}',
   E'Hi {customer_name},\n\nThanks for your purchase at {store_name}! Your downloads are ready:\n\n{download_links}\n\nEach link works for {expiry_days} days and allows up to {max_downloads} downloads. Save the files to your device.\n\nOrder: {order_no}\n\nIf you have any trouble downloading, just reply to this email.'),
  ('es', 'Tus descargas de {store_name} — pedido {order_no}',
   E'Hola {customer_name},\n\n¡Gracias por tu compra en {store_name}! Tus descargas están listas:\n\n{download_links}\n\nCada enlace funciona durante {expiry_days} días y permite hasta {max_downloads} descargas. Guarda los archivos en tu dispositivo.\n\nPedido: {order_no}\n\nSi tienes algún problema para descargar, responde a este correo.')
) AS v(locale, subject, body)
WHERE NOT EXISTS (
  SELECT 1 FROM "email_templates" e WHERE e."tenant_id" IS NULL AND e."key" = 'digital-delivery' AND e."locale" = v.locale
);
