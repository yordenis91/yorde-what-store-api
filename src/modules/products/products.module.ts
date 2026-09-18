import { Module } from '@nestjs/common';
import { CategoryTemplatesModule } from '../category-templates/category-templates.module';
import { PlansModule } from '../plans/plans.module';
import { AuditModule } from '../audit/audit.module';
import {
  ProductsController,
  StorefrontProductsController,
  StorefrontCategoriesController,
} from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [CategoryTemplatesModule, PlansModule, AuditModule],
  controllers: [ProductsController, StorefrontProductsController, StorefrontCategoriesController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
