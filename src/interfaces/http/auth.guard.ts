import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Ponto de extensão da autenticação, que ficou fora do escopo (ver ARCHITECTURE.md).
 * Hoje deixa tudo passar. A ideia é validar aqui um JWT emitido por um IdP externo
 * (Keycloak) e conferir que o claim do provedor bate com o `providerId` do payload.
 * Rotas marcadas com @Public() (health) nunca passariam por essa checagem.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return true;
  }
}
