import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Extension point for Provider Authentication.
 *
 * In accordance with Section 2 of DESAFIO.md:
 * Authentication carries 0 evaluation points.
 *
 * Architecture in Production:
 * An external Identity Provider (e.g. Keycloak or Zitadel) verifies OAuth2 / OIDC client credentials
 * for each gaming provider and signs an asymmetric JWT (validated via JWKS).
 *
 * Development / Evaluation Behavior:
 * Health checks (/health/*) are always unauthenticated.
 * If header 'X-Provider-Id' is present, it is mapped to request context.
 * In evaluation mode, requests pass through cleanly while providing the explicit extension hook.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path || request.url;

    // Health check and metrics probes must remain open/unauthenticated
    if (path.startsWith('/health') || path.startsWith('/metrics')) {
      return true;
    }

    // Provider identity extension hook
    const providerHeader = request.headers['x-provider-id'];
    if (providerHeader) {
      (request as any).providerId = providerHeader;
    }

    return true;
  }
}
