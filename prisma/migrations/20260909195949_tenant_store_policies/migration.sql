-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "privacy_policy_content" TEXT,
ADD COLUMN     "return_policy_content" TEXT,
ADD COLUMN     "shipping_policy_content" TEXT,
ADD COLUMN     "terms_of_sale_content" TEXT;
