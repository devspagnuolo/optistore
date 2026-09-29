import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

const PG_MAP: Record<string, [number, string]> = {
  '23505': [HttpStatus.CONFLICT, 'Registro duplicado'],
  '23503': [HttpStatus.BAD_REQUEST, 'Referência inválida'],
  '23514': [HttpStatus.BAD_REQUEST, 'Valor fora das regras permitidas'],
  '22P02': [HttpStatus.BAD_REQUEST, 'Formato inválido'],
  '42501': [HttpStatus.FORBIDDEN, 'Acesso negado'],
};

/** Maps DB errors to safe HTTP responses; never leaks SQL details or stack traces. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) {
      return res.status(err.getStatus()).json(err.getResponse());
    }
    const code = (err as { code?: string })?.code;
    if (code && PG_MAP[code]) {
      const [status, message] = PG_MAP[code];
      return res.status(status).json({ statusCode: status, message });
    }
    this.log.error(err instanceof Error ? err.stack : String(err));
    return res.status(500).json({ statusCode: 500, message: 'Erro interno' });
  }
}
