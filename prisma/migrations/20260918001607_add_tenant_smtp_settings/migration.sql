-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "smtp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smtp_from" TEXT,
ADD COLUMN     "smtp_host" TEXT,
ADD COLUMN     "smtp_password" TEXT,
ADD COLUMN     "smtp_port" INTEGER,
ADD COLUMN     "smtp_user" TEXT;
