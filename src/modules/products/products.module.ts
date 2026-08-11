import { Module } from '@nestjs/common';
import { ProductsController, StorefrontProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [ProductsController, StorefrontProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
