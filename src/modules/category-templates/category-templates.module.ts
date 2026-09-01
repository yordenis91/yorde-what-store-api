import { Module } from '@nestjs/common';
import { CategoryTemplatesController } from './category-templates.controller';
import { CategoryTemplatesService } from './category-templates.service';

@Module({
  controllers: [CategoryTemplatesController],
  providers: [CategoryTemplatesService],
  exports: [CategoryTemplatesService],
})
export class CategoryTemplatesModule {}
