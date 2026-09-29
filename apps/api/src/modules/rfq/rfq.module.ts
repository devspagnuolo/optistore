import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../../common/auth.types';
import { OrdersModule } from '../orders/orders.module';
import { CreateQuoteDto, CreateRfqDto } from './rfq.dto';
import { RfqService } from './rfq.service';

@Controller('rfqs')
export class RfqController {
  constructor(private svc: RfqService) {}
  @Roles('buyer') @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateRfqDto) { return this.svc.create(u, dto); }
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }

  @Roles('seller') @Post(':id/quotes')
  quote(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateQuoteDto) {
    return this.svc.createQuote(u, id, dto);
  }

  @Roles('buyer') @Post(':id/quotes/:quoteId/accept')
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('quoteId', ParseUUIDPipe) quoteId: string) {
    return this.svc.accept(u, id, quoteId);
  }
}

@Module({ imports: [OrdersModule], controllers: [RfqController], providers: [RfqService] })
export class RfqModule {}
