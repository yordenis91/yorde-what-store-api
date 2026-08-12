import { Module } from '@nestjs/common';
import { ProductsController, StorefrontProductsController, StorefrontCategoriesController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [ProductsController, StorefrontProductsController, StorefrontCategoriesController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
