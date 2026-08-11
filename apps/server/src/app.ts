import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { HttpError, attachUser } from './auth/guards.js';
import { authRoutes } from './routes/auth.js';
import { actorRoutes } from './routes/actors.js';
import { campaignRoutes } from './routes/campaigns.js';
import { itemRoutes } from './routes/items.js';
import { sceneRoutes } from './routes/scenes.js';
import { env, paths } from './env.js';

export async function buildApp() {
  const app = Fastify({
    logger: env.isProd ? true : { transport: { target: 'pino-pretty' } },
    bodyLimit: env.maxUploadBytes,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: env.maxUploadBytes, files: 1 },
  });

  // Uploads are served straight off disk; filenames are generated, never
  // user-supplied, so there is no traversal surface here.
  await app.register(fastifyStatic, {
    root: paths.uploads,
    prefix: '/uploads/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '7d',
  });

  app.decorateRequest('user', null);
  app.addHook('preHandler', attachUser);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status < 500) {
      return reply.code(status).send({ error: (error as Error).message });
    }

    request.log.error(error);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  await app.register(authRoutes);
  await app.register(campaignRoutes);
  await app.register(actorRoutes);
  await app.register(itemRoutes);
  await app.register(sceneRoutes);

  return app;
}
