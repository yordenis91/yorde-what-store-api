-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN     "template_id" UUID;

-- CreateTable
CREATE TABLE "category_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_templates_slug_key" ON "category_templates"("slug");

-- CreateIndex
CREATE INDEX "category_templates_parent_id_idx" ON "category_templates"("parent_id");

-- CreateIndex
CREATE INDEX "product_categories_template_id_idx" ON "product_categories"("template_id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "category_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_templates" ADD CONSTRAINT "category_templates_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "category_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
