-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BANNED', 'TRIAL_EXPIRED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "admin_metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "commission_rate" DECIMAL(5,2),
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "limits_override" JSONB,
ADD COLUMN     "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "tenant_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_status" "TenantStatus" NOT NULL,
    "to_status" "TenantStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_impersonation_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "tenant_impersonation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_notes_tenant_id_idx" ON "tenant_notes"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_status_history_tenant_id_idx" ON "tenant_status_history"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_impersonation_logs_tenant_id_idx" ON "tenant_impersonation_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_impersonation_logs_admin_id_idx" ON "tenant_impersonation_logs"("admin_id");

-- AddForeignKey
ALTER TABLE "tenant_notes" ADD CONSTRAINT "tenant_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_notes" ADD CONSTRAINT "tenant_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_status_history" ADD CONSTRAINT "tenant_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_status_history" ADD CONSTRAINT "tenant_status_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_impersonation_logs" ADD CONSTRAINT "tenant_impersonation_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_impersonation_logs" ADD CONSTRAINT "tenant_impersonation_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
