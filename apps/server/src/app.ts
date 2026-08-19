import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { HttpError, attachUser } from './auth/guards.js';
import { authRoutes } from './routes/auth.js';
import { actorRoutes } from './routes/actors.js';
import { campaignRoutes } from './routes/campaigns.js';
import { itemRoutes } from './routes/items.js';
import { journalRoutes } from './routes/journal.js';
import { sceneRoutes } from './routes/scenes.js';
import fs from 'node:fs';
import path from 'node:path';
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

  // Bestiary art from the SRD import. Served separately from uploads so the
  // orphan sweep, which only ever touches `/uploads/`, cannot delete art that
  // every NPC stamped from a monster shares. Filenames come from the monster
  // index, never from a request.
  await app.register(fastifyStatic, {
    root: paths.srdImages,
    prefix: '/srd-images/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '30d',
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
  await app.register(journalRoutes);

  await serveClient(app);

  return app;
}

/**
 * Serves the built client, so one process on one port is the whole app.
 *
 * The not-found handler is the important half: React Router owns paths like
 * /campaigns/:id/table, and without returning index.html for them a refresh -
 * the first thing anyone does - would 404. API routes are excluded so a
 * genuine bad endpoint still answers with JSON rather than a page.
 */
async function serveClient(app: FastifyInstance): Promise<void> {
  const index = path.join(paths.webDist, 'index.html');

  if (!fs.existsSync(index)) {
    // Development runs the client on Vite instead; this is not an error.
    app.log.info('No client build found - run `npm run build` to serve it from here');
    return;
  }

  await app.register(fastifyStatic, {
    root: paths.webDist,
    prefix: '/',
    decorateReply: false,
    // Off, so setHeaders owns the header outright - otherwise the plugin
    // writes its own default over the top.
    cacheControl: false,
    // Hashed asset filenames can be cached hard; index.html must not be.
    setHeaders(response, filePath) {
      if (filePath.endsWith('index.html')) response.setHeader('cache-control', 'no-cache');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        response.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });

  const html = fs.readFileSync(index, 'utf8');

  app.setNotFoundHandler((request, reply) => {
    // A missing asset path must 404, not fall through to the SPA shell: an
    // <img> that receives index.html renders as a broken image with a 200,
    // which is a great deal harder to diagnose than a 404.
    if (
      request.method !== 'GET' ||
      request.url.startsWith('/api') ||
      request.url.startsWith('/uploads') ||
      request.url.startsWith('/srd-images')
    ) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.type('text/html').header('cache-control', 'no-cache').send(html);
  });
}
