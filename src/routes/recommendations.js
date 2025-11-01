// backend/src/routes/recommendations.js
const { Router } = require('express');
const { v4: uuid } = require('uuid');
const { runRecommendationJob } = require('../services/recommendations');

const recommendationsRouter = Router();

/**
 * Memoria simple de jobs (en RAM)
 * status: QUEUED | RUNNING | DONE | ERROR
 */
const jobs = new Map();

/**
 * Encola un job de recomendaciones usando el JWT del usuario y la URL de la API real.
 * Body: { top_n?: number, filter?: object, user_jwt?: string, api_base_url?: string }
 */
recommendationsRouter.post('/queue', async (req, res) => {
  try {
    const body = req.body || {};
    const top_n = Number.isFinite(body.top_n) ? body.top_n : 8;
    const filter = (body.filter && typeof body.filter === 'object') ? body.filter : {};
    const user_jwt = typeof body.user_jwt === 'string' ? body.user_jwt : '';
    const api_base_url_raw = typeof body.api_base_url === 'string' ? body.api_base_url : '';

    if (!user_jwt) {
      return res.status(401).json({ error: 'Missing user_jwt in body' });
    }

    const api_base_url_env = process.env.API_BASE_URL || '';
    const api_base_url = String(api_base_url_raw || api_base_url_env).replace(/\/$/, '');
    if (!api_base_url) {
      return res.status(500).json({ error: 'Missing api_base_url (body or env API_BASE_URL)' });
    }

    const job_id = uuid();
    jobs.set(job_id, { status: 'QUEUED' });

    // Procesamiento asíncrono simple (sin colas externas)
    (async () => {
      jobs.set(job_id, { status: 'RUNNING' });
      try {
        const result = await runRecommendationJob(
          { top_n, filter },
          { apiBaseUrl: api_base_url, token: user_jwt }
        );
        jobs.set(job_id, { status: 'DONE', result });
      } catch (err) {
        const msg = (err && err.message) ? err.message : 'Worker error';
        jobs.set(job_id, { status: 'ERROR', error: msg });
      }
    })();

    return res.json({ job_id });
  } catch (err) {
    return res.status(500).json({ error: err && err.message ? err.message : 'Queue error' });
  }
});

/**
 * Consulta el estado del job
 * GET /recommendations/status/:jobId
 */
recommendationsRouter.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params || {};
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Normalizamos el payload
  const payload = {
    job: {
      status: job.status,
      result: job.result,
      error: job.error
    }
  };
  return res.json(payload);
});

module.exports = { recommendationsRouter };
