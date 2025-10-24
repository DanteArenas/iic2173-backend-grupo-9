import 'dotenv/config';
import Koa from 'koa';
import Router from '@koa/router';
import { koaBody } from 'koa-body';
import cors from 'cors';
import IORedis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';

const app = new Koa();
const router = new Router();

const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL;
const JOB_MASTER_TOKEN = process.env.JOB_MASTER_TOKEN || '';

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const connection = redis;

const QUEUE_NAME = 'recommendations';
const queue = new Queue(QUEUE_NAME, { connection });
const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

// CORS simple
app.use((ctx, next) => {
  cors({ origin: '*' })(ctx.req, ctx.res, () => {});
  return next();
});
app.use(koaBody());

// RF04 (heartbeat que usará tu backend como proxy)
router.get('/heartbeat', async (ctx) => {
  try {
    const t0 = Date.now();
    await redis.ping();
    const latency = Date.now() - t0;
    const [waiting, active, delayed, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getCompletedCount(),
      queue.getFailedCount()
    ]);
    ctx.body = { ok: true, latency_ms: latency, queue: { waiting, active, delayed, completed, failed } };
  } catch (err) {
    ctx.status = 500;
    ctx.body = { ok: false, error: err.message };
  }
});

// Encolar recomendaciones (lo invoca el web_server tras /properties/buy)
router.post('/jobs/recommendations', async (ctx) => {
  const token = ctx.get('x-job-token');
  if (!JOB_MASTER_TOKEN || token !== JOB_MASTER_TOKEN) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { user_id, request_id, property_url } = ctx.request.body || {};
  if (!user_id || !request_id || !property_url) {
    ctx.status = 400;
    ctx.body = { error: 'Missing user_id, request_id, or property_url' };
    return;
  }

  const job = await queue.add(
    'generate-recommendations',
    { user_id, request_id, property_url },
    { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }
  );

  ctx.body = { enqueued: true, job_id: job.id };
});

// Inspección de un job
router.get('/jobs/:id', async (ctx) => {
  const job = await queue.getJob(ctx.params.id);
  if (!job) {
    ctx.status = 404;
    ctx.body = { error: 'Job not found' };
    return;
  }
  const state = await job.getState();
  const logs = await job.getLogs();
  ctx.body = {
    id: job.id,
    name: job.name,
    data: job.data,
    state,
    returnvalue: job.returnvalue,
    attemptsMade: job.attemptsMade,
    logs
  };
});

app.use(router.routes()).use(router.allowedMethods());
app.listen(PORT, () => console.log(`Job Master listening on :${PORT}`));

// logs básicos
queueEvents.on('completed', ({ jobId }) => console.log(`Job ${jobId} completed`));
queueEvents.on('failed', ({ jobId, failedReason }) => console.error(`Job ${jobId} failed: ${failedReason}`));
