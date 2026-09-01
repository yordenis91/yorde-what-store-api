import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { CategoryTemplatesService } from './category-templates.service';
import { CreateCategoryTemplateDto, UpdateCategoryTemplateDto } from './dto';

@ApiTags('platform-category-templates')
@Roles('SUPER_ADMIN')
@Controller('platform/category-templates')
export class CategoryTemplatesController {
  constructor(private readonly categoryTemplatesService: CategoryTemplatesService) {}

  @Get()
  listAll() {
    return this.categoryTemplatesService.listAll();
  }

  @Post()
  create(@Body() dto: CreateCategoryTemplateDto) {
    return this.categoryTemplatesService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryTemplateDto) {
    return this.categoryTemplatesService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.categoryTemplatesService.remove(id);
  }
}
