import 'dotenv/config';
import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import { Client } from 'pg';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// Conexión a la misma BD del web_server
const pg = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB
});
await pg.connect();

const QUEUE = 'recommendations';

// Helpers mínimos
async function getPropertyByUrl(url) {
  const q = `
    SELECT id, data, reservation_cost
    FROM properties
    WHERE data->>'url' = $1
    LIMIT 1`;
  const { rows } = await pg.query(q, [url]);
  return rows[0] || null;
}

// Reglas simples: mismas ubicación y +/-20% precio
async function computeRecommendations(base) {
  if (!base?.data) return [];
  const loc = (base.data.location || '').toLowerCase();
  const price = Number(base.data.price);
  const curr = (base.data.currency || '').toUpperCase();
  const minP = Number.isFinite(price) ? price * 0.8 : null;
  const maxP = Number.isFinite(price) ? price * 1.2 : null;

  const q = `
    SELECT id, data, reservation_cost
    FROM properties
    WHERE LOWER(COALESCE(data->>'location','')) LIKE '%' || $1 || '%'
      AND ($2::numeric IS NULL OR (data->>'price')::numeric >= $2)
      AND ($3::numeric IS NULL OR (data->>'price')::numeric <= $3)
      AND ($4::text IS NULL OR UPPER(COALESCE(data->>'currency','')) = $4)
      AND data->>'url' <> $5
    ORDER BY (data->>'timestamp')::timestamp DESC
    LIMIT 8`;
  const { rows } = await pg.query(q, [loc || '', minP, maxP, curr || null, base.data.url]);
  return rows.map(r => ({ property_id: r.id, data: r.data, reservation_cost: r.reservation_cost }));
}

async function saveRecommendations(user_id, request_id, items) {
  const insert = `
    INSERT INTO recommendations (id, user_id, request_id, items, created_at)
    VALUES (gen_random_uuid(), $1, $2, $3::jsonb, NOW())
    ON CONFLICT (request_id) DO UPDATE
      SET items = EXCLUDED.items, created_at = NOW()
    RETURNING id`;
  const { rows } = await pg.query(insert, [user_id, request_id, JSON.stringify(items || [])]);
  return rows[0]?.id;
}

// Worker
const worker = new Worker(
  QUEUE,
  async (job) => {
    const { user_id, request_id, property_url } = job.data;
    job.log(`Compute recs for ${request_id}`);
    const base = await getPropertyByUrl(property_url);
    if (!base) return { saved: false, reason: 'base_property_not_found' };
    const items = await computeRecommendations(base);
    const recId = await saveRecommendations(user_id, request_id, items);
    return { saved: true, rec_id: recId, count: items.length };
  },
  { connection }
);

worker.on('completed', (job, res) => console.log(`Job ${job.id} completed`, res));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed`, err?.message));
