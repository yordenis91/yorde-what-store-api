-- CreateTable
CREATE TABLE "customer_refresh_tokens" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_password_reset_tokens" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_refresh_tokens_customer_id_idx" ON "customer_refresh_tokens"("customer_id");

-- CreateIndex
CREATE INDEX "customer_password_reset_tokens_customer_id_idx" ON "customer_password_reset_tokens"("customer_id");

-- AddForeignKey
ALTER TABLE "customer_refresh_tokens" ADD CONSTRAINT "customer_refresh_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_password_reset_tokens" ADD CONSTRAINT "customer_password_reset_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security: these tables have no tenant_id column of their own (they
-- scope to a customer, not directly to a tenant), so tenant isolation is
-- enforced by joining to customers instead of comparing tenant_id directly.
-- Mirrors the tenant_isolation policy convention from the init migration.
ALTER TABLE "customer_refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_refresh_tokens"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "customers" c
      WHERE c.id = "customer_refresh_tokens"."customer_id"
        AND c.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "customers" c
      WHERE c.id = "customer_refresh_tokens"."customer_id"
        AND c.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );

ALTER TABLE "customer_password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_password_reset_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_password_reset_tokens"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "customers" c
      WHERE c.id = "customer_password_reset_tokens"."customer_id"
        AND c.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "customers" c
      WHERE c.id = "customer_password_reset_tokens"."customer_id"
        AND c.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );
