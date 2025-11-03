import dotenv from "dotenv";
import { Pool } from "pg";
import Redis from "ioredis";

dotenv.config({ path: process.env.DOTENV_PATH || "../../.env" });

const pg = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT || 6379)
});

console.log("Rec Worker started. Waiting for jobs…");

async function processOne(raw) {
  const job = JSON.parse(raw);
  const { job_id, user_id, top_n = 8, filter = {} } = job;

  try {
    // Construimos filtro simple sobre properties
    const clauses = [];
    const params = [];
    let p = 1;

    if (filter.location) {
      clauses.push(`LOWER((data->>'location')) LIKE $${p++}`);
      params.push(`%${String(filter.location).toLowerCase()}%`);
    }

    if (filter.max_price) {
      clauses.push(`(data->>'price')::numeric <= $${p++}`);
      params.push(Number(filter.max_price));
      // Si pasas currency en el filtro y quieres separar, aquí podrías usar (data->>'currency')
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const sql = `
      SELECT id, data, reservation_cost, visits, updated_at
      FROM properties
      ${whereSql}
      ORDER BY COALESCE(visits,0) DESC, reservation_cost DESC NULLS LAST, updated_at DESC
      LIMIT $${p}
    `;
    params.push(Number(top_n));

    const { rows } = await pg.query(sql, params);

    // Resultado "recomendaciones"
    const recommendations = rows.map(r => ({
      property_id: r.id,
      url: r.data?.url || null,
      location: r.data?.location || null,
      price: r.data?.price ?? null,
      currency: r.data?.currency || null,
      reservation_cost: r.reservation_cost ?? null,
      visits: r.visits ?? 0,
      updated_at: r.updated_at
    }));

    // Guarda resultado y marca DONE
    await pg.query(
      `INSERT INTO recommendations_results (job_id, user_id, result_json)
       VALUES ($1, $2, $3::jsonb)`,
      [job_id, user_id, JSON.stringify({ recommendations })]
    );

    await pg.query(
      `UPDATE recommendations_queue
       SET status = 'DONE', finished_at = NOW(), error_message = NULL
       WHERE job_id = $1`,
      [job_id]
    );

    console.log(`Job ${job_id} DONE (${recommendations.length} items)`);
  } catch (err) {
    console.error(`Job ${job_id} FAILED`, err);
    await pg.query(
      `UPDATE recommendations_queue
       SET status = 'FAILED', finished_at = NOW(), error_message = $2
       WHERE job_id = $1`,
      [job_id, err.message]
    );
  }
}

async function loop() {
  while (true) {
    try {
      // Espera bloqueante
      const res = await redis.brpop("recs:queue", 0);
      if (res && res[1]) {
        await processOne(res[1]);
      }
    } catch (err) {
      console.error("Worker loop error:", err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

loop();



