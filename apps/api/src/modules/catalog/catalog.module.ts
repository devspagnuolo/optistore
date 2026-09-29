import { Body, Controller, Get, Module, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, DefaultValuePipe } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../../common/auth.types';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './catalog.dto';

@Controller('catalog')
export class CatalogController {
  constructor(private svc: CatalogService) {}

  @Roles('seller') @Post('products')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateProductDto) { return this.svc.createProduct(u, dto); }

  @Roles('seller') @Patch('products/:id/publish')
  publish(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.publish(u, id); }

  @Get('products')
  search(@CurrentUser() u: AuthUser, @Query('q') q?: string, @Query('category') category?: string,
         @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
         @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize = 20) {
    return this.svc.search(u, q, category, page, pageSize);
  }

  @Get('products/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }
}

@Module({ controllers: [CatalogController], providers: [CatalogService] })
export class CatalogModule {}
