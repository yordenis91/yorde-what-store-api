-- AlterEnum
ALTER TYPE "FulfillmentMethod" ADD VALUE 'ZELLE';

-- AlterEnum
ALTER TYPE "PaymentProvider" ADD VALUE 'ZELLE';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_proof_url" TEXT,
ADD COLUMN     "payment_reference" TEXT;
