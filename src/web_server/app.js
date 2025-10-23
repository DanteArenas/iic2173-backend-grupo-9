// web_server/app.js
require('newrelic');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Carga .env desde la raíz del repo (../../.env) o local si no existe arriba
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const { fetch } = require('undici'); // 👈 RF04: para ping a job-master

const sendPurchaseRequest = require('./listener/sendPurchaseRequest');
const republishPurchaseRequest = require('./listener/republishPurchaseRequest');

const Koa = require('koa');
const { koaBody } = require('koa-body');
const jwt = require('koa-jwt');
const jwksRsa = require('jwks-rsa');
const cors = require('@koa/cors');

const sequelize = require('./database');
const Property = require('./models/Property');
const User = require('./models/User');
const Request = require('./models/Request'); 
const { createTransaction, commitTransaction, mapWebpayStatus} = require("./services/webpayService")
const { getUfValue } = require('./services/ufService');
const { v4: uuidv4 } = require('uuid');

const { Op } = require('sequelize');

const { fetch: undiciFetch } = require('undici');
const _fetch = global.fetch || undiciFetch;

const JOB_MASTER_URL = process.env.JOB_MASTER_URL || "http://job-master:8080";
const JOB_MASTER_TOKEN = process.env.JOB_MASTER_TOKEN;


// ————————————————————————————————————————————————————————————————
// DB: asegurar columna retry_used e índice (idempotente)
// ————————————————————————————————————————————————————————————————
async function ensureDbSchemaUpgrades() {
  try {
    await sequelize.query(
      `ALTER TABLE purchase_requests
       ADD COLUMN IF NOT EXISTS retry_used BOOLEAN NOT NULL DEFAULT FALSE`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_requests_retry_used
       ON purchase_requests (retry_used)`
    );
    console.log('✅ Esquema verificado: columna retry_used lista.');
  } catch (err) {
    console.warn('⚠️ No se pudo asegurar el esquema (retry_used):', err.message || err);
  }
}

sequelize.authenticate()
  .then(async () => {
    console.log('Conexión exitosa a la base de datos con Sequelize');
    await ensureDbSchemaUpgrades();
  })
  .catch(err => console.error('Error de conexión con Sequelize:', err));

const Router = require('@koa/router');
const app = new Koa();

// ————————————————————————————————————————————————————————————————
// CORS
// ————————————————————————————————————————————————————————————————
const buildCorsOptions = () => {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    return { origin: '*' };
  }
  return {
    origin: ctx => {
      const requestOrigin = ctx.request.header.origin;
      if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        return requestOrigin;
      }
      return undefined;
    }
  };
};

app.use(cors(buildCorsOptions()));
app.use(koaBody());

// ————————————————————————————————————————————————————————————————
// Auth0 (middleware por ruta)
// ————————————————————————————————————————————————————————————————
const createAuthMiddleware = () => {
  const issuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
  const audience = process.env.AUTH0_AUDIENCE;

  if (!issuerBaseUrl || !audience) {
    console.warn('⚠️ Missing Auth0 configuration. Set AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE to protect routes.');
    return async (ctx, next) => {
      ctx.status = 500;
      ctx.body = { error: 'Server misconfigured: Auth0 environment variables missing' };
    };
  }

  const issuer = issuerBaseUrl.endsWith('/') ? issuerBaseUrl : `${issuerBaseUrl}/`;

  return jwt({
    secret: jwksRsa.koaJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri: `${issuer}.well-known/jwks.json`,
    }),
    audience,
    issuer,
    algorithms: ['RS256'],
  });
};

const requireAuth = createAuthMiddleware();

// ————————————————————————————————————————————————————————————————
// Preflight OPTIONS: 204 (antes de validar JWT)
// ————————————————————————————————————————————————————————————————
app.use(async (ctx, next) => {
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
  } else {
    await next();
  }
});

// ————————————————————————————————————————————————————————————————
// Manejo de errores 401 limpio
// ————————————————————————————————————————————————————————————————
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err.status === 401) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized', message: err.message };
    } else {
      throw err;
    }
  }
});

// ————————————————————————————————————————————————————————————————
// Helpers de propiedades / validaciones
// ————————————————————————————————————————————————————————————————
const validatePropertyPayload = payload => {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { isValid: false, errors: ['Request body must be a JSON object'] };
  }

  const sanitized = { ...payload };

  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    errors.push('`url` must be a non-empty string');
  } else {
    try {
      const normalizedUrl = new URL(payload.url.trim());
      sanitized.url = normalizedUrl.toString();
    } catch {
      errors.push('`url` must be a valid URL');
    }
  }

  if (typeof payload.timestamp !== 'string' || payload.timestamp.trim() === '') {
    errors.push('`timestamp` must be provided as a string');
  } else {
    const parsedTimestamp = Date.parse(payload.timestamp);
    if (Number.isNaN(parsedTimestamp)) {
      errors.push('`timestamp` must be a valid date/time');
    } else {
      sanitized.timestamp = new Date(parsedTimestamp).toISOString();
    }
  }

  if (payload.location !== undefined) {
    if (typeof payload.location !== 'string' || payload.location.trim() === '') {
      errors.push('`location` must be a non-empty string when provided');
    } else {
      sanitized.location = payload.location.trim();
    }
  }

  if (payload.price !== undefined) {
    let priceValue = payload.price;
    if (typeof priceValue === 'string') priceValue = priceValue.trim();
    if (priceValue === '') {
      errors.push('`price` must not be empty when provided');
    } else {
      const parsedPrice = Number(priceValue);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        errors.push('`price` must be a non-negative number when provided');
      } else {
        sanitized.price = parsedPrice;
      }
    }
  }

  if (payload.currency !== undefined) {
    if (typeof payload.currency !== 'string' || payload.currency.trim() === '') {
      errors.push('`currency` must be a non-empty string when provided');
    } else {
      sanitized.currency = payload.currency.trim().toUpperCase();
    }
  }

  return { isValid: errors.length === 0, errors, value: sanitized };
};

const RESERVATION_RATE = 0.1;
const normalizeCurrency = currency =>
  typeof currency === 'string' ? currency.trim().toUpperCase() : null;

const computeReservationCost = async property => {
  if (!property || !Number.isFinite(property.price)) {
    return null;
  }
  const currency = normalizeCurrency(property.currency) || 'CLP';
  if (currency === 'UF') {
    const ufValue = await getUfValue(property.timestamp);
    if (!Number.isFinite(ufValue)) {
      throw new Error('UF value is not numeric');
    }
    return Math.round(property.price * ufValue * RESERVATION_RATE);
  }
  return Math.round(property.price * RESERVATION_RATE);
};

// ————————————————————————————————————————————————————————————————
// RF04: Heartbeat público (sin autenticación)
// ————————————————————————————————————————————————————————————————
function resolveHeartbeatUrl() {
  const explicit = process.env.JOB_MASTER_HEARTBEAT_URL;
  if (explicit && explicit.trim()) return explicit.trim();

  const base = process.env.JOB_MASTER_URL;
  if (base && base.trim()) {
    return `${base.replace(/\/$/, '')}/heartbeat`;
  }
  return null;
}

const HEARTBEAT_TIMEOUT_MS = 2500;
const router = new Router();

router.get('/workers/heartbeat', async (ctx) => {
  const t0 = Date.now();
  try {
    const res = await _fetch(`${JOB_MASTER_URL}/health`, {
      headers: { Authorization: `Bearer ${JOB_MASTER_TOKEN}` }
    });
    const ok = res.ok;
    const t1 = Date.now();
    ctx.body = { ok, latency_ms: t1 - t0 };
  } catch (err) {
    const t1 = Date.now();
    ctx.status = 200; // para que el frontend lo pinte, pero "offline"
    ctx.body = { ok: false, latency_ms: t1 - t0, error: err.message };
  }
});

router.post('/recommendations/queue', requireAuth, async (ctx) => {
  try {
    const user = await getOrCreateUserFromToken(ctx.state.user || {});
    const { top_n = 8, filter = {} } = ctx.request.body || {};

    const resp = await _fetch(`${JOB_MASTER_URL}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JOB_MASTER_TOKEN}`
      },
      body: JSON.stringify({ user_id: user.id, top_n, filter })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      ctx.status = 502;
      ctx.body = { error: 'Job master error', details: txt };
      return;
    }

    const json = await resp.json();
    ctx.status = 202;
    ctx.body = json; // { job_id, status: "QUEUED" }
  } catch (err) {
    ctx.status = 500;
    ctx.body = { error: 'Internal error', details: err.message };
  }
});

router.get('/recommendations/status/:job_id', requireAuth, async (ctx) => {
  const { job_id } = ctx.params;
  try {
    const user = await getOrCreateUserFromToken(ctx.state.user || {});
    const resp = await _fetch(`${JOB_MASTER_URL}/jobs/${encodeURIComponent(job_id)}`, {
      headers: { Authorization: `Bearer ${JOB_MASTER_TOKEN}` }
    });

    if (resp.status === 404) {
      ctx.status = 404;
      ctx.body = { error: 'Job not found' };
      return;
    }
    if (!resp.ok) {
      const txt = await resp.text();
      ctx.status = 502;
      ctx.body = { error: 'Job master error', details: txt };
      return;
    }

    const data = await resp.json(); // { job, result }
    if (data?.job?.user_id && data.job.user_id !== user.id) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden (different owner)' };
      return;
    }

    ctx.body = data;
  } catch (err) {
    ctx.status = 500;
    ctx.body = { error: 'Internal error', details: err.message };
  }
});


// ————————————————————————————————————————————————————————————————
// Rutas protegidas
// ————————————————————————————————————————————————————————————————

// /me
router.get('/me', requireAuth, async ctx => {
  const getOrCreateUserFromToken = async tokenPayload => {
    const payload = tokenPayload || {};
    const auth0UserId = payload.sub;
    if (!auth0UserId) throw new Error('sub claim is required');

    const emailClaim = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const nameClaim = typeof payload.name === 'string' && payload.name.trim() !== ''
      ? payload.name.trim()
      : null;

    const defaultName = nameClaim || emailClaim || 'Auth0 User';
    const defaultEmail = emailClaim || `${auth0UserId.replace(/[^a-zA-Z0-9]/g, '_')}@auth0.local`;

    const [user] = await User.findOrCreate({
      where: { auth0_user_id: auth0UserId },
      defaults: {
        full_name: defaultName,
        email: defaultEmail,
      },
    });

    const updates = {};
    if (nameClaim && user.full_name !== nameClaim) updates.full_name = nameClaim;
    if (emailClaim && user.email !== emailClaim) updates.email = emailClaim;
    if (Object.keys(updates).length > 0) await user.update(updates);
    return user;
  };

  try {
    const user = await getOrCreateUserFromToken(ctx.state.user || {});
    ctx.body = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
      auth0_user_id: user.auth0_user_id,
    };
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid token payload', message: err.message };
  }
});

// /properties POST
router.post('/properties', requireAuth, async ctx => {
  try {
    const { isValid, errors, value: property } = validatePropertyPayload(ctx.request.body);
    if (!isValid) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid property payload', details: errors };
      return;
    }

    let reservationCost = null;
    try {
      reservationCost = await computeReservationCost(property);
    } catch (calcError) {
      console.warn('⚠️ Unable to compute reservation cost, continuing without it', calcError);
    }

    const result = await Property.findOne({
      where: sequelize.where(
        sequelize.json('data.url'),
        property.url
      ),
      attributes: ['id']
    });

    if (result) {
      const updates = {
        visits: sequelize.literal('COALESCE(visits, 0) + 1'),
        updated_at: property.timestamp
      };
      if (reservationCost !== null) updates.reservation_cost = reservationCost;
      await Property.update(updates, { where: { id: result.id } });
      ctx.status = 200;
    } else {
      await Property.create({
        data: property,
        updated_at: property.timestamp,
        reservation_cost: reservationCost
      });
      ctx.status = 201;
    }
  } catch (err) {
    console.error('Error inserting property:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

// /properties GET
router.get('/properties', requireAuth, async ctx => {
  try {
    const { page = 1, limit = 25, price, location, date, currency } = ctx.query;
    const offset = (page - 1) * limit;

    const where = [];
    if (price) {
      where.push(
        sequelize.where(
          sequelize.cast(sequelize.json('data.price'), 'numeric'),
          { [Op.lt]: parseFloat(price) }
        )
      );
      where.push(
        sequelize.where(
          sequelize.json('data.currency'),
          (currency && currency.toLowerCase() === 'uf') ? 'UF' : '$'
        )
      );
    }
    if (location) {
      where.push(
        sequelize.where(
          sequelize.fn('unaccent', sequelize.fn('lower', sequelize.json('data.location'))),
          { [Op.like]: `%${String(location).toLowerCase()}%` }
        )
      );
    }
    if (date) {
      where.push(
        sequelize.where(
          sequelize.fn('DATE', sequelize.cast(sequelize.json('data.timestamp'), 'timestamp')),
          date
        )
      );
    }

    const properties = await Property.findAll({
      where: where.length > 0 ? { [Op.and]: where } : undefined,
      order: [[sequelize.literal("(data->>'timestamp')::timestamp"), 'ASC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    ctx.body = properties;
  } catch (err) {
    console.error('Error fetching properties:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

// /properties/:id GET
router.get('/properties/:id', requireAuth, async ctx => {
  const { id } = ctx.params;
  try {
    const property = await Property.findByPk(id);
    if (!property) {
      ctx.status = 404;
      ctx.body = { error: 'Property not found' };
      return;
    }
    ctx.body = property;
  } catch (err) {
    console.error('Error fetching property:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

// RF05: /properties/buy
router.post('/properties/buy', requireAuth, async ctx => {
    const { url } = ctx.request.body;

    if (!url ) {
        ctx.status = 400;
        ctx.body = { error: "URL es requerido" };
        return;
    }

    try {
        console.log('🔄 Processing buy request:', { url });

        let user;
        try {
            user = await getOrCreateUserFromToken(ctx.state.user || {});
        } catch (err) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid token payload', message: err.message };
            return;
        }
        // 1. Buscar propiedad en DB
        const property = await Property.findOne({
            where: sequelize.where(
                sequelize.json('data.url'),
                url
            ),
        });
        if (!property) {
            ctx.status = 404;
            ctx.body = { error: "Property not found" };
            return;
        }
        const reservation_cost = await computeReservationCost(property.data);
        const requestId = uuidv4();
        const buyOrder = requestId.replace(/-/g, "").substring(0, 26);
        const returnUrl = process.env.API_LOCAL || 'http://';
        
    
        const tx = await createTransaction(
            buyOrder,
            String(user.id),
            reservation_cost ,
            `${returnUrl}/webpay/commit`
        );

        const requestPayload = await sendPurchaseRequest(url, reservation_cost, user.id, tx.token, requestId, buyOrder);
        // Descontar una visita de la propiedad propia
        if (property && property.visits > 0) {
            await property.update({ visits: property.visits - 1 });
            console.log(`🔽 Visita descontada al reservar propiedad: ${url}`);
        }

        console.log('✅ Buy request processed successfully:', requestPayload);
        ctx.body = {
            message: "Solicitud enviada",
            request: {
                ...requestPayload,
                user_id: user.id,
                token: tx.token,
                url: tx.url,
            }
        };
    } catch (err) {
        console.error("❌ Error en /buy:", {
            message: err.message,
            stack: err.stack,
            url,
            reservation_cost
        });
        ctx.status = 500;
        ctx.body = {
            error: "Error al enviar solicitud",
            details: err.message,
            request_id: err.request_id || null
        };
    }
  const { url, reservation_cost } = ctx.request.body;

  if (!url || !reservation_cost) {
    ctx.status = 400;
    ctx.body = { error: "URL y reservation_cost son requeridos" };
    return;
  }

  // helper local para user
  const getOrCreateUserFromToken = async tokenPayload => {
    const payload = tokenPayload || {};
    const auth0UserId = payload.sub;
    if (!auth0UserId) throw new Error('sub claim is required');

    const emailClaim = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const nameClaim = typeof payload.name === 'string' && payload.name.trim() !== ''
      ? payload.name.trim()
      : null;

    const defaultName = nameClaim || emailClaim || 'Auth0 User';
    const defaultEmail = emailClaim || `${auth0UserId.replace(/[^a-zA-Z0-9]/g, '_')}@auth0.local`;

    const [user] = await User.findOrCreate({
      where: { auth0_user_id: auth0UserId },
      defaults: {
        full_name: defaultName,
        email: defaultEmail,
      },
    });

    const updates = {};
    if (nameClaim && user.full_name !== nameClaim) updates.full_name = nameClaim;
    if (emailClaim && user.email !== emailClaim) updates.email = emailClaim;
    if (Object.keys(updates).length > 0) await user.update(updates);
    return user;
  };

  try {
    console.log('🔄 Processing buy request:', { url, reservation_cost });
    const user = await getOrCreateUserFromToken(ctx.state.user || {});

    const requestPayload = await sendPurchaseRequest(url, reservation_cost, user.id);
    console.log('✅ Buy request processed successfully:', requestPayload);

    ctx.body = {
      message: "Solicitud enviada",
      request: {
        ...requestPayload,
        user_id: user.id,
      }
    };
  } catch (err) {
    console.error("❌ Error en /buy:", {
      message: err.message,
      stack: err.stack,
      url,
      reservation_cost
    });
    ctx.status = 500;
    ctx.body = {
      error: "Error al enviar solicitud",
      details: err.message,
      request_id: err.request_id || null
    };
  }
});

// /reservations GET
router.get('/reservations', requireAuth, async ctx => {
  const getOrCreateUserFromToken = async tokenPayload => {
    const payload = tokenPayload || {};
    const auth0UserId = payload.sub;
    if (!auth0UserId) throw new Error('sub claim is required');

    const emailClaim = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const nameClaim = typeof payload.name === 'string' && payload.name.trim() !== ''
      ? payload.name.trim()
      : null;

    const defaultName = nameClaim || emailClaim || 'Auth0 User';
    const defaultEmail = emailClaim || `${auth0UserId.replace(/[^a-zA-Z0-9]/g, '_')}@auth0.local`;

    const [user] = await User.findOrCreate({
      where: { auth0_user_id: auth0UserId },
      defaults: {
        full_name: defaultName,
        email: defaultEmail,
      },
    });

    const updates = {};
    if (nameClaim && user.full_name !== nameClaim) updates.full_name = nameClaim;
    if (emailClaim && user.email !== emailClaim) updates.email = emailClaim;
    if (Object.keys(updates).length > 0) await user.update(updates);
    return user;
  };

  let user;
  try {
    user = await getOrCreateUserFromToken(ctx.state.user || {});
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid token payload', message: err.message };
    return;
  }

  try {
    const reservations = await Request.findAll({
      where: { user_id: user.id },
      order: [['created_at', 'DESC']],
    });

    ctx.body = reservations.map(reservation => reservation.toJSON());
  } catch (err) {
    console.error('Error fetching reservations:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

// /reservations/:request_id/retry POST
router.post('/reservations/:request_id/retry', requireAuth, async ctx => {
  const { request_id } = ctx.params;

  const getOrCreateUserFromToken = async tokenPayload => {
    const payload = tokenPayload || {};
    const auth0UserId = payload.sub;
    if (!auth0UserId) throw new Error('sub claim is required');

    const emailClaim = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const nameClaim = typeof payload.name === 'string' && payload.name.trim() !== ''
      ? payload.name.trim()
      : null;

    const defaultName = nameClaim || emailClaim || 'Auth0 User';
    const defaultEmail = emailClaim || `${auth0UserId.replace(/[^a-zA-Z0-9]/g, '_')}@auth0.local`;

    const [user] = await User.findOrCreate({
      where: { auth0_user_id: auth0UserId },
      defaults: {
        full_name: defaultName,
        email: defaultEmail,
      },
    });

    const updates = {};
    if (nameClaim && user.full_name !== nameClaim) updates.full_name = nameClaim;
    if (emailClaim && user.email !== emailClaim) updates.email = emailClaim;
    if (Object.keys(updates).length > 0) await user.update(updates);
    return user;
  };

  let user;
  try {
    user = await getOrCreateUserFromToken(ctx.state.user || {});
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid token payload', message: err.message };
    return;
  }

  if (!request_id) {
    ctx.status = 400;
    ctx.body = { error: 'Missing request_id' };
    return;
  }

  try {
    const request = await Request.findOne({ where: { request_id } });
    if (!request) {
      ctx.status = 404;
      ctx.body = { error: 'Request not found' };
      return;
    }

    if (request.user_id !== user.id) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const status = String(request.status || '').toUpperCase();
    if (!['ERROR', 'REJECTED'].includes(status)) {
      ctx.status = 400;
      ctx.body = { error: 'Only failed requests can be retried' };
      return;
    }

    if (request.retry_used) {
      ctx.status = 400;
      ctx.body = { error: 'Retry already used for this request' };
      return;
    }

    // Re-publicar en MQTT con el mismo request_id primero
    const payload = await republishPurchaseRequest(request_id);

    // Marcar como reintento usado y resetear estado a OK tras publicación exitosa
    await request.update({ retry_used: true, status: 'OK', reason: null });

    ctx.body = {
      message: 'Solicitud reintentada',
      request: {
        request_id: request.request_id,
        user_id: request.user_id,
        property_url: request.property_url,
        amount_clp: request.amount_clp,
        status: request.status,
        retry_used: true,
        payload,
      },
    };
  } catch (err) {
    console.error('❌ Error en retry:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error', details: err.message };
  }
});

// RF02: Detalle de reserva
router.get('/reservations/:request_id', requireAuth, async ctx => {
  const { request_id } = ctx.params;

  const getOrCreateUserFromToken = async tokenPayload => {
    const payload = tokenPayload || {};
    const auth0UserId = payload.sub;
    if (!auth0UserId) throw new Error('sub claim is required');

    const emailClaim = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const nameClaim = typeof payload.name === 'string' && payload.name.trim() !== ''
      ? payload.name.trim()
      : null;

    const defaultName = nameClaim || emailClaim || 'Auth0 User';
    const defaultEmail = emailClaim || `${auth0UserId.replace(/[^a-zA-Z0-9]/g, '_')}@auth0.local`;

    const [user] = await User.findOrCreate({
      where: { auth0_user_id: auth0UserId },
      defaults: {
        full_name: defaultName,
        email: defaultEmail,
      },
    });

    const updates = {};
    if (nameClaim && user.full_name !== nameClaim) updates.full_name = nameClaim;
    if (emailClaim && user.email !== emailClaim) updates.email = emailClaim;
    if (Object.keys(updates).length > 0) await user.update(updates);
    return user;
  };

  let user;
  try {
    user = await getOrCreateUserFromToken(ctx.state.user || {});
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid token payload', message: err.message };
    return;
  }

  try {
    const reservationRequest = await Request.findOne({
      where: {
        request_id,
        user_id: user.id,
      }
    });

    if (!reservationRequest) {
      ctx.status = 404;
      ctx.body = { error: 'Reservation request not found or not owned by user' };
      return;
    }

    const property = await Property.findOne({
      where: sequelize.where(
        sequelize.json('data.url'),
        reservationRequest.property_url
      ),
    });

    const responseData = {
      status: reservationRequest.status,
      reservation_details: reservationRequest.toJSON(),
      property_details: property ? property.toJSON() : null,
      reservations_cost_clp: reservationRequest.amount_clp,
    };

    ctx.body = responseData;
    ctx.status = 200;
  } catch (err) {
    console.error('❌ Error fetching reservation request details:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});
//post para actualizar info de webpay
router.post('/webpay/commit', async ctx => {
  try {
    const { token_ws } = ctx.request.body;
    if (!token_ws) {
      ctx.status = 400;
      ctx.body = { error: "token_ws es requerido" };
      return;
    }

    // 1. Confirmar transacción con WebPay
    const result = await commitTransaction(token_ws);
    console.log("💳 Resultado commit:", result);
    
    const mappedStatus = mapWebpayStatus(result);
    
    // 2. Actualizar en DB
    await Request.update(
      { status: mappedStatus },
      { where: { deposit_token: token_ws } }
    );
    // 🔄 Si falla o se rechaza, devolver la visita
    if (["REJECTED", "ERROR"].includes(mappedStatus)) {
        const property = await Property.findOne({
            where: sequelize.where(
            sequelize.json('data.url'),
            request.property_url
        ),
        });
        if (property) {
            await property.update({ visits: property.visits + 1 });
            console.log(`🔼 Visita devuelta a propiedad: ${request.property_url}`);
        }
    }

    // 3. Publicar validación en broker
    const payload = {
      request_id: result.buy_order,
      timestamp: new Date().toISOString(),
      status: mappedStatus,
      reason: result.response_code === 0 ? "Pago aprobado" : "Pago fallido"
    };
    client.publish("properties/validation", JSON.stringify(payload));
    console.log("📤 Enviado a properties/validation:", payload);

    // 4. Responder al frontend
    ctx.body = {
      message: "Resultado de la transacción",
      result
    };
  } catch (err) {
    console.error("❌ Error en /webpay/commit:", err);
    ctx.status = 500;
    ctx.body = { error: "Error confirmando transacción", details: err.message };
  }
});

router.get('/webpay/commit', async ctx => {
  const { token_ws, TBK_TOKEN, TBK_ORDEN_COMPRA } = ctx.query;

  try {
    if (token_ws) {
      // ✅ Caso normal: commit de transacción
      const result = await commitTransaction(token_ws);
      const mappedStatus = mapWebpayStatus(result);

      await Request.update(
        { status: mappedStatus },
        { where: { deposit_token: token_ws } }
      );

      const frontendUrl = process.env.FRONTEND_URL || "http://";
      ctx.redirect(`${frontendUrl}/payment-result?status=${mappedStatus}&order=${result.buy_order}`);

    } else if (TBK_TOKEN) {
      // ❌ Caso de anulación por el usuario
      console.log("🚫 Compra anulada por el usuario:", TBK_TOKEN, TBK_ORDEN_COMPRA);

      await Request.update(
        { status: "REJECTED", reason: "Usuario anuló la compra" },
        { where: { buy_order: TBK_ORDEN_COMPRA } }
      );

      const frontendUrl = process.env.FRONTEND_URL || "http://";
      ctx.redirect(`${frontendUrl}/payment-result?status=REJECTED&order=${TBK_ORDEN_COMPRA}`);

    } else {
      ctx.status = 400;
      ctx.body = { error: "Falta token_ws o TBK_TOKEN en query" };
    }

  } catch (err) {
    console.error("❌ Error en GET /webpay/commit:", err);
    ctx.redirect(`${process.env.FRONTEND_URL}/payment-result?status=ERROR`);
  }
});

// ————————————————————————————————————————————————————————————————
// Mount router
// ————————————————————————————————————————————————————————————————
app.use(router.routes()).use(router.allowedMethods());

const PORT = process.env.APP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor web corriendo en puerto ${PORT}`);
});
