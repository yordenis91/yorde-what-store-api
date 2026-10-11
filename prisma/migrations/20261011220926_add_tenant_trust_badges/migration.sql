-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "trust_badges" JSONB NOT NULL DEFAULT '{"shipping":{"enabled":true,"text":"Envío gratis"},"payment":{"enabled":true,"text":"Pago seguro"},"delivery":{"enabled":true,"text":"Entrega rápida"}}';
