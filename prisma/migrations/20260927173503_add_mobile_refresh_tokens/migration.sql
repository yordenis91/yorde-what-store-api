-- CreateTable
CREATE TABLE "mobile_refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "tenant_id" UUID,
    "tenant_role" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_customer_refresh_tokens" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_customer_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mobile_refresh_tokens_user_id_idx" ON "mobile_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "mobile_refresh_tokens_family_id_idx" ON "mobile_refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "mobile_customer_refresh_tokens_customer_id_idx" ON "mobile_customer_refresh_tokens"("customer_id");

-- CreateIndex
CREATE INDEX "mobile_customer_refresh_tokens_family_id_idx" ON "mobile_customer_refresh_tokens"("family_id");

-- AddForeignKey
ALTER TABLE "mobile_refresh_tokens" ADD CONSTRAINT "mobile_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_customer_refresh_tokens" ADD CONSTRAINT "mobile_customer_refresh_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security: unlike customer_refresh_tokens (joins through customers),
-- this table carries its own tenant_id, so it uses the direct-column policy
-- convention — post-20260816191200_fix_rls_bypass_after_tenant_scope version,
-- with nullif(..., '') guarding the cast from the start (see that migration's
-- comment for why a bare current_setting(...)::uuid isn't safe here).
ALTER TABLE "mobile_customer_refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mobile_customer_refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mobile_customer_refresh_tokens"
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.bypass_rls', true) = 'on'
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.bypass_rls', true) = 'on'
  );

-- mobile_refresh_tokens (staff) is intentionally NOT RLS-enabled, matching its
-- web counterpart refresh_tokens: staff Users aren't tenant-partitioned data,
-- access is scoped by userId in application code, same as refresh_tokens and
-- password_reset_tokens above.
