-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "session_id" UUID;

-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "session_id" UUID;

-- CreateIndex
CREATE INDEX "visits_tenant_id_session_id_idx" ON "visits"("tenant_id", "session_id");
