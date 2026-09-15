-- AlterEnum
ALTER TYPE "FulfillmentMethod" ADD VALUE 'MERCADOPAGO';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "mercado_pago_payment_id" TEXT,
ADD COLUMN     "mercado_pago_preference_id" TEXT;
