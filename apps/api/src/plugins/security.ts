import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';

export interface SecurityOptions {
  allowedOrigins: string[];
  appEnv: 'dev' | 'staging' | 'production';
}

/**
 * Security headers (CSP etc.) + CORS. CORS origins are explicit from
 * ALLOWED_ORIGINS — never a reflected wildcard with credentials.
 */
export const securityPlugin: FastifyPluginAsync<SecurityOptions> = async (fastify, opts) => {
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await fastify.register(cors, {
    origin: opts.allowedOrigins.length > 0 ? opts.allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id', 'Idempotency-Key', 'If-None-Match', 'If-Match'],
    exposedHeaders: ['X-Request-Id', 'ETag', 'Retry-After'],
    maxAge: 600,
  });
};
