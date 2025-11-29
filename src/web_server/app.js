// Envía métricas solo si New Relic está configurado (evita crash en local)
try { const newrelic = require('newrelic'); } catch (e) { console.warn('New Relic not started:', e.message); }
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

// Imports externos / utils Koa
const mount = require('koa-mount');
const serve = require('koa-static');

const Koa = require('koa');
const Router = require('@koa/router');
const { koaBody } = require('koa-body');
const jwt = require('koa-jwt');
const jwksRsa = require('jwks-rsa');
const cors = require('@koa/cors');

// DB
const sequelize = require('./database');
const { Op } = require('sequelize');
const Property = require('./models/Property');
const User = require('./models/User');
const Request = require('./models/Request');
const { Auction, Schedule, ExchangeProposal } = require("./models");


// Servicios internos
const { publishValidation } = require('./services/publishValidation');
const sendAuctionEvent = require('./listener/sendAuctionEvent');
const sendPurchaseRequest = require('./listener/sendPurchaseRequest');
const republishPurchaseRequest = require('./listener/republishPurchaseRequest');
const { createTransaction, commitTransaction, mapWebpayStatus } = require('./services/webpayService');
const { getUfValue } = require('./services/ufService');

const { runRecommendationJob } = require('./services/recommendations');
// =================================================================
const { generarBoletaDesdeApiGateway } = require('./services/boletaService');
const { ensureDbSchemaUpgrades } = require('./services/schemaService');

// Otros helpers
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const { fetch: undiciFetch } = require('undici');
const _fetch = global.fetch || undiciFetch;

// ---- Constantes de entorno
const JOB_MASTER_URL = process.env.JOB_MASTER_URL || 'http://job-master:8080';
const JOB_MASTER_TOKEN = process.env.JOB_MASTER_TOKEN;

const WEBPAY_RETURN_URL = process.env.WEBPAY_RETURN_URL;
const WEBPAY_RETURN_URL_USER = process.env.WEBPAY_RETURN_URL_USER;
const FRONTEND_URL = process.env.FRONTEND_URL; // dominio deploy
const PUBLIC_FRONTEND_URL = process.env.PUBLIC_FRONTEND_URL; // p.e. http://localhost:5173
const FRONT = PUBLIC_FRONTEND_URL || FRONTEND_URL || 'http://localhost:5173';
const ADMIN_AUTH0_IDS = new Set(
  (process.env.ADMIN_AUTH0_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const DEFAULT_GROUP_ID = Number.isFinite(Number(process.env.DEFAULT_GROUP_ID))
  ? Number(process.env.DEFAULT_GROUP_ID)
  : null;

// ---- Usuario desde token Auth0
const getOrCreateUserFromToken = async (tokenPayload) => {
  const payload = tokenPayload || {};
  const auth0UserId = payload.sub;
  if (!auth0UserId) throw new Error('sub claim is required');

  const emailClaim = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  const nameClaim =
    typeof payload.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : null;

  const defaultName = nameClaim || emailClaim || 'Auth0 User';
  const defaultEmail =
    emailClaim || `${auth0UserId.replace(/[^a-zA-Z0-9]/g, '_')}@auth0.local`;
  const shouldBeAdmin = ADMIN_AUTH0_IDS.has(auth0UserId);

  const [user] = await User.findOrCreate({
    where: { auth0_user_id: auth0UserId },
    defaults: {
      full_name: defaultName,
      email: defaultEmail,
      is_admin: shouldBeAdmin,
      group_id: DEFAULT_GROUP_ID,
    },
  });

  const updates = {};
  if (nameClaim && user.full_name !== nameClaim) updates.full_name = nameClaim;
  if (emailClaim && user.email !== emailClaim) updates.email = emailClaim;
  if (shouldBeAdmin && !user.is_admin) updates.is_admin = true;
  if (!user.group_id && DEFAULT_GROUP_ID) updates.group_id = DEFAULT_GROUP_ID;
  if (Object.keys(updates).length > 0) await user.update(updates);

  return user;
};

// ---- Conexión DB
sequelize
  .authenticate()
  .then(async () => {
    console.log('Conexión exitosa a la base de datos con Sequelize');
    await ensureDbSchemaUpgrades(sequelize);
  })
  .catch((err) => console.error('Error de conexión con Sequelize:', err));

// ---- App Koa
const app = new Koa();

// (opcional) Servir PDFs locales si existieran en disco, ya no es crítico con Lambda+S3
app.use(mount('/invoices', serve(path.join(__dirname, 'invoices'))));

// --- LOGGING MIDDLEWARE (Inicio)
app.use(async (ctx, next) => {
  console.log(`--> ${ctx.method} ${ctx.path} (Inicio Request)`);
  await next();
  console.log(`<-- ${ctx.method} ${ctx.path} (Fin Request - Status: ${ctx.status})`);
});

// --- CORS
const buildCorsOptions = () => {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    console.warn('⚠️ CORS_ALLOWED_ORIGINS not set, allowing all origins.');
    return {
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'x-group-id'],
      credentials: true,
    };
  }

  return {
    origin: (ctx) => {
      const requestOrigin = ctx.request.header.origin;
      if (!requestOrigin) {
        // permit server-to-server requests (no Origin header) by reflecting first allowed entry
        return allowedOrigins[0];
      }
      if (allowedOrigins.includes(requestOrigin)) {
        return requestOrigin;
      }
      console.warn(
        `🚫 CORS blocked origin: ${requestOrigin} (Not in allowed list: ${allowedOrigins.join(
          ', '
        )})`
      );
      return undefined;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'x-group-id'],
    credentials: true,
  };
};

app.use(cors(buildCorsOptions()));

// --- BODY PARSER
app.use(koaBody());

// --- AUTH0 JWT
const createAuthMiddleware = () => {
  const issuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
  const audience = process.env.AUTH0_AUDIENCE;

  if (!issuerBaseUrl || !audience) {
    console.error(
      '❌ FATAL: Missing Auth0 configuration. Set AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE.'
    );
    return async (ctx) => {
      ctx.status = 500;
      ctx.body = { error: 'Server misconfigured: Auth0 environment variables missing' };
    };
  }

  const issuer = issuerBaseUrl.endsWith('/') ? issuerBaseUrl : `${issuerBaseUrl}/`;
  console.log(`🔒 Auth0 configured: Issuer=${issuer}, Audience=${audience}`);

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

const getGroupId = (user) => (user && (user.group_id || user.id)) || null;
const scheduleFinalPrice = (schedule) => {
  if (!schedule) return null;
  const base = Number(schedule.price_clp) || 0;
  const pct = Number(schedule.discount_pct) || 0;
  const bounded = Math.min(Math.max(pct, 0), 10);
  return Math.max(0, Math.round(base * (1 - bounded / 100)));
};

const requireAdmin = async (ctx, next) => {
  let user;
  try {
    user = await getOrCreateUserFromToken(ctx.state.user || {});
  } catch (err) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid token payload', message: err.message };
    return;
  }
  if (!user || !user.is_admin) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden', message: 'Admin access required' };
    return;
  }
  ctx.state.dbUser = user;
  await next();
};

// --- LOG antes de OPTIONS
app.use(async (ctx, next) => {
  console.log(`--> ${ctx.method} ${ctx.path} (Antes del handler OPTIONS)`);
  await next();
});

// --- OPTIONS handler (preflight antes del JWT)
app.use(async (ctx, next) => {
  if (ctx.method === 'OPTIONS') {
    console.log(`--> OPTIONS ${ctx.path}: Setting 204 y terminando.`);
    ctx.status = 204;
  } else {
    console.log(`--> ${ctx.method} ${ctx.path}: No es OPTIONS, llamando a next().`);
    await next();
  }
});

// --- LOG antes del error handler
app.use(async (ctx, next) => {
  console.log(`--> ${ctx.method} ${ctx.path} (Antes del handler de errores)`);
  await next();
});

// --- GLOBAL ERROR HANDLER (incluye 401 JWT)
app.use(async (ctx, next) => {
  try {
    console.log(
      `--> ${ctx.method} ${ctx.path} (Dentro del try del handler de errores, llamando a next())`
    );
    await next();
    console.log(
      `--> ${ctx.method} ${ctx.path} (Después de next() en handler de errores - Status final: ${ctx.status})`
    );

    if (ctx.status === 404 && !ctx.body) {
      console.log(
        `--> ${ctx.method} ${ctx.path} (Ruta no encontrada, devolviendo 404 JSON)`
      );
      ctx.body = { error: 'Not Found', message: `No route found for ${ctx.method} ${ctx.path}` };
    }
  } catch (err) {
    console.error(
      `--> ${ctx.method} ${ctx.path} (Error capturado en handler global)`,
      {
        status: err.status,
        message: err.message,
        stack: err.stack,
      }
    );

    if (err.status === 401) {
      console.log(
        `--> ${ctx.method} ${ctx.path} (Devolviendo error 401 JSON porque err.status es 401)`
      );
      ctx.status = 401;
      ctx.body = {
        error: 'Unauthorized',
        message: err.originalError ? err.originalError.message : err.message,
      };
    } else {
      console.error(
        `--> ${ctx.method} ${ctx.path} (Error NO 401 capturado (${err.status || 'sin status'}), devolviendo 500 JSON)`
      );
      ctx.status = err.status || 500;
      ctx.body = {
        error: err.name || 'Internal Server Error',
        message: err.message || 'An unexpected error occurred.',
      };
    }
  }
});

// ---- Helpers de validación + precio
const validatePropertyPayload = (payload) => {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { isValid: false, errors: ['Request body must be a JSON object'] };
  }
  const sanitized = { ...payload };

  // url
  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    errors.push('`url` must be a non-empty string');
  } else {
    try {
      const normalized = new URL(payload.url.trim());
      sanitized.url = normalized.toString();
    } catch {
      errors.push('`url` must be a valid URL');
    }
  }

  // timestamp
  if (typeof payload.timestamp !== 'string' || payload.timestamp.trim() === '') {
    errors.push('`timestamp` must be provided as a string');
  } else {
    const parsed = Date.parse(payload.timestamp);
    if (Number.isNaN(parsed)) {
      errors.push('`timestamp` must be a valid ISO 8601 date/time string');
    } else {
      sanitized.timestamp = new Date(parsed).toISOString();
    }
  }

  // location (opcional)
  if (payload.location !== undefined && payload.location !== null) {
    if (typeof payload.location !== 'string' || payload.location.trim() === '') {
      errors.push('`location` must be a non-empty string when provided');
    } else {
      sanitized.location = payload.location.trim();
    }
  } else {
    sanitized.location = null;
  }

  // price (opcional)
  if (payload.price !== undefined && payload.price !== null && payload.price !== '') {
    let priceValue = payload.price;
    if (typeof priceValue === 'string')
      priceValue = priceValue.trim().replace(/[$.]/g, '');
    const parsedPrice = Number(priceValue);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      errors.push('`price` must be a non-negative number when provided');
    } else {
      sanitized.price = parsedPrice;
    }
  } else {
    sanitized.price = null;
  }

  // currency (opcional)
  if (payload.currency !== undefined && payload.currency !== null) {
    if (typeof payload.currency !== 'string' || payload.currency.trim() === '') {
      errors.push('`currency` must be a non-empty string when provided (e.g., CLP, UF)');
    } else {
      sanitized.currency = payload.currency.trim().toUpperCase();
      if (sanitized.currency === '$') sanitized.currency = 'CLP';
    }
  } else if (sanitized.price !== null) {
    sanitized.currency = 'CLP';
    console.warn(
      `⚠️ Currency not provided for price ${sanitized.price}, assuming CLP.`
    );
  } else {
    sanitized.currency = null;
  }

  return { isValid: errors.length === 0, errors, value: sanitized };
};

const RESERVATION_RATE = 0.1;
const normalizeCurrency = (c) =>
  typeof c === 'string' ? c.trim().toUpperCase() : null;

const computeReservationCost = async (propertyData) => {
  if (
    !propertyData ||
    typeof propertyData.price !== 'number' ||
    !Number.isFinite(propertyData.price) ||
    propertyData.price < 0
  ) {
    console.warn(
      'computeReservationCost: Invalid or missing numeric price.',
      propertyData
    );
    return null;
  }
  const price = propertyData.price;
  const currency = normalizeCurrency(propertyData.currency) || 'CLP';
  const timestamp = propertyData.timestamp || new Date().toISOString();

  try {
    if (currency === 'UF') {
      const ufValue = await getUfValue(timestamp);
      if (
        typeof ufValue !== 'number' ||
        !Number.isFinite(ufValue) ||
        ufValue <= 0
      ) {
        console.error(
          `computeReservationCost: Invalid UF for ${timestamp}. Got: ${ufValue}`
        );
        throw new Error(
          'UF value is invalid or could not be retrieved'
        );
      }
      return Math.round(price * ufValue * RESERVATION_RATE);
    }
    if (currency === 'CLP') return Math.round(price * RESERVATION_RATE);
    console.warn(
      `computeReservationCost: Unsupported currency "${currency}" provided.`
    );
    return null;
  } catch (err) {
    console.error(
      `computeReservationCost: Error calculating cost for price=${price} ${currency} at ${timestamp}:`,
      err
    );
    return null;
  }
};

// ---- Router
const router = new Router();

router.get('/health', async (ctx) => {
  try {
    // Verifica la conexión a la base de datos
    await sequelize.authenticate();

    ctx.status = 200;
    ctx.body = { status: 'UP', message: 'Application is healthy' };
  } catch (err) {
    console.error('Health check failed:', err);
    ctx.status = 500;
    ctx.body = { status: 'DOWN', message: 'Application is not healthy', error: err.message };
  }
});

// ---- SCHEDULES (Public view and Admin management)
router.get('/properties/:id/schedules', async (ctx) => {
  const propertyId = parseInt(ctx.params.id, 10);
  if (Number.isNaN(propertyId) || propertyId < 1) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid property ID' };
    return;
  }
  const property = await Property.findByPk(propertyId);
  if (!property || !property.data || !property.data.url) {
    ctx.status = 404;
    ctx.body = { error: 'Property not found' };
    return;
  }
  const schedules = await Schedule.findAll({
    where: {
      property_url: property.data.url,
      status: { [Op.in]: ['AVAILABLE', 'AUCTION', 'OWNED'] },
    },
  });
  ctx.body = schedules.map((s) => {
    const plain = s.toJSON();
    return { ...plain, final_price_clp: scheduleFinalPrice(plain) };
  });
});

router.patch(
  '/admin/schedules/:id',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const scheduleId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(scheduleId) || scheduleId < 1) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid schedule ID' };
      return;
    }

    const schedule = await Schedule.findByPk(scheduleId);
    if (!schedule) {
      ctx.status = 404;
      ctx.body = { error: 'Schedule not found' };
      return;
    }

    const adminUser = ctx.state.dbUser ||
      (await getOrCreateUserFromToken(ctx.state.user || {}));
    const myGroup = getGroupId(adminUser);

    if (schedule.owner_group_id !== myGroup) {
      ctx.status = 403;
      ctx.body = { 
        error: 'Forbidden',
        message: 'You can only edit schedules owned by your group' 
      };
      return;
    }

    const { discount_pct, status } = ctx.request.body || {};

    const updates = {};

    if (discount_pct !== undefined) {
      const discount = Number(discount_pct);
      if (!Number.isFinite(discount) || discount < 0 || discount > 10) {
        ctx.status = 400;
        ctx.body = { error: 'discount_pct must be between 0 and 10%' };
        return;
      }
      updates.discount_pct = Math.round(discount);
    }

    if (status !== undefined) {
      const upper = String(status).toUpperCase();
      if (!['AVAILABLE', 'OWNED', 'SOLD'].includes(upper)) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid status' };
        return;
      }
      updates.status = upper;
    }

    await schedule.update({ 
      ...updates,
      updated_at: new Date(),
    });

    ctx.body = {
      message: 'Schedule updated successfully',
      schedule: schedule.toJSON(),
      final_price_clp: scheduleFinalPrice(schedule),
    };
  }
);


// POST /schedules/:id/purchase
router.post(
  '/schedules/:id/purchase',
  requireAuth,   // usuario normal
  async (ctx) => {
    console.log("WEBPAY_RETURN_URL_USER:", WEBPAY_RETURN_URL_USER);
    const scheduleId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(scheduleId) || scheduleId < 1) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid schedule ID' };
      return;
    }

    const schedule = await Schedule.findByPk(scheduleId);
    if (!schedule) {
      ctx.status = 404;
      ctx.body = { error: 'Schedule not found' };
      return;
    }

    const status = String(schedule.status || '').toUpperCase();
    if (status !== 'AVAILABLE') {
      ctx.status = 409;
      ctx.body = { error: 'Schedule not available for purchase' };
      return;
    }

    const user = ctx.state.dbUser || await getOrCreateUserFromToken(ctx.state.user);
    const finalPrice = scheduleFinalPrice(schedule);

    if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid schedule price' };
      return;
    }

    // 1) Crear Request USER_PURCHASE
    const requestId = uuidv4();
    const buyOrder = requestId.replace(/-/g, '').slice(0, 20);

    const requestRow = await Request.create({
      request_id: requestId,
      buy_order: buyOrder,
      user_id: user.id,
      property_url: schedule.property_url,
      schedule_id: schedule.id,
      amount_clp: finalPrice,
      status: 'PENDING',
      reason: 'User purchase of schedule',
      retry_used: false,
      deposit_token: null,
      invoice_url: null
    });
    console.log('returnurl:', WEBPAY_RETURN_URL_USER);
    // 2) Crear transacción Webpay
    const init = await createTransaction(
      buyOrder,
      user.id.toString(),
      finalPrice,
      WEBPAY_RETURN_URL_USER
    );

    // Guardamos token en request
    await requestRow.update({
      deposit_token: init.token
    });

    ctx.body = {
      url: init.url,
      token: init.token,
      request_id: requestId
    };
  }
);

router.post(
  '/payments/webpay/return-user',
  koaBody({ urlencoded: true, json: false }),
  async (ctx) => {
    const token = ctx.request.body?.token_ws;
    if (!token) {
      ctx.status = 400;
      ctx.body = 'Missing token_ws';
      return;
    }

    // 1) Confirmar en Webpay
    const result = await commitTransaction(token);
    const mapped = mapWebpayStatus(result);

    const t = await sequelize.transaction();
    let requestRow = null;

    try {
      requestRow = await Request.findOne({
        where: { deposit_token: token },
        lock: t.LOCK.UPDATE,
        transaction: t
      });

      if (!requestRow) {
        await t.rollback();
        ctx.status = 404;
        ctx.body = 'Request not found';
        return;
      }

      // 2) Actualizar request
      await requestRow.update(
        {
          status: mapped,
          reason: result.response_code === 0 ? 'Payment approved' : 'Payment failed',
          updated_at: new Date()
        },
        { transaction: t }
      );

      // 3) Si ACCEPTED → transferir schedule al usuario
      if (mapped === 'ACCEPTED') {
        await ensureInvoiceForRequestRow(requestRow)
        const schedule = await Schedule.findByPk(requestRow.schedule_id);

        await schedule.update(
          {
            status: 'SOLD',
            owner_group_id: requestRow.user_id, // o getGroupId
            updated_at: new Date()
          },
          { transaction: t }
        );
      }

      await t.commit();

    } catch (e) {
      try { await t.rollback(); } catch {}
      console.error('Return-user error:', e);
      ctx.status = 500;
      ctx.body = 'Internal error';
      return;
    }

    // 4) Redirigir al front
    const statusParam = mapped === 'ACCEPTED' ? 'ok' : 'failed';
    ctx.status = 302;
    ctx.redirect(`${FRONT}/reservations/${requestRow.request_id}?status=${statusParam}`);
  }
);

router.get('/payments/webpay/return-user', async (ctx) => {
  const { token_ws, TBK_TOKEN, TBK_ORDEN_COMPRA } = ctx.query;

  // Igual que en retorno normal
  if (!token_ws) {
    ctx.status = 400;
    ctx.body = 'Missing token_ws';
    return;
  }

  // Confirmación idempotente en Webpay
  const result = await commitTransaction(token_ws);
  const mapped = mapWebpayStatus(result);

  const t = await sequelize.transaction();
  let requestRow = null;

  try {
    requestRow = await Request.findOne({
      where: { deposit_token: token_ws },
      lock: t.LOCK.UPDATE,
      transaction: t
    });

    if (!requestRow) {
      await t.rollback();
      ctx.status = 404;
      ctx.body = 'Request not found';
      return;
    }


    // Actualizar estado
    await requestRow.update(
      {
        status: mapped,
        reason: result.response_code === 0 ? 'Payment approved (GET)' : 'Payment failed (GET)',
        updated_at: new Date()
      },
      { transaction: t }
    );
    
    // Transferencia del schedule
    if (mapped === 'ACCEPTED') {
      await ensureInvoiceForRequestRow(requestRow)
      const schedule = await Schedule.findByPk(requestRow.schedule_id);

      await schedule.update(
        {
          status: 'SOLD',
          owner_group_id: requestRow.user_id,
          updated_at: new Date()
        },
        { transaction: t }
      );
    }

    await t.commit();

    const statusParam = mapped === 'ACCEPTED' ? 'ok' : 'failed';
    ctx.status = 302;
    ctx.redirect(`${FRONT}/reservations/${requestRow.request_id}?status=${statusParam}`);
  } catch (e) {
    try { await t.rollback(); } catch {}
    console.error('GET return-user error:', e);
    ctx.status = 500;
    ctx.body = 'Internal error';
  }
});

router.post(
  '/admin/schedules/:id/auction',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const scheduleId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(scheduleId)) return ctx.throw(400, 'Invalid schedule ID');

    const schedule = await Schedule.findByPk(scheduleId);
    if (!schedule) return ctx.throw(404, 'Schedule not found');

    const adminUser = ctx.state.dbUser || (await getOrCreateUserFromToken(ctx.state.user));
    const myGroup = getGroupId(adminUser);

    if (schedule.owner_group_id !== myGroup)
      return ctx.throw(403, 'Forbidden');

    const status = schedule.status.toUpperCase();
    if (!['OWNED', 'AVAILABLE'].includes(status))
      return ctx.throw(400, 'Schedule must be OWNED or AVAILABLE to auction');

    const now = new Date();
    const auctionUuid = uuidv4();

    const minPriceBody = Number(ctx.request.body?.min_price);
    const minPrice =
      Number.isFinite(minPriceBody) && minPriceBody > 0
        ? Math.round(minPriceBody)
        : scheduleFinalPrice(schedule);

    // 1) Crear la subasta en tu BD
    const auction = await Auction.create({
      schedule_id: schedule.id,
      owner_group_id: myGroup,
      min_price: minPrice,
      status: "OPEN",
      auction_uuid: auctionUuid,
      created_at: now,
      updated_at: now,
    });

    // 2) Actualizar el schedule a AUCTION
    await schedule.update({ status: "AUCTION", updated_at: now });

    // 3) Enviar el evento de OFFER al broker
    const event = {
      auction_id: auctionUuid,
      proposal_id: "",
      url: schedule.property_url,
      timestamp: now.toISOString(),
      quantity: 1,
      group_id: myGroup,
      operation: "offer",
    };

    await sendAuctionEvent(event);

    ctx.status = 201;
    ctx.body = { auction, schedule };
  }
);


router.post(
  '/admin/auctions/:id/proposals',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const auctionId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(auctionId)) return ctx.throw(400, 'Invalid auction ID');

    const auction = await Auction.findByPk(auctionId);
    if (!auction) return ctx.throw(404, 'Auction not found');

    if (auction.status !== 'OPEN') return ctx.throw(409, 'Auction not open');

    const adminUser = ctx.state.dbUser || (await getOrCreateUserFromToken(ctx.state.user));
    const fromGroup = getGroupId(adminUser);
    const toGroup = auction.owner_group_id;

    if (fromGroup === toGroup)
      return ctx.throw(400, 'Cannot propose to your own auction');

    const { offering_schedule_id, message } = ctx.request.body || {};

    let offeringSchedule = null;
    if (offering_schedule_id) {
      offeringSchedule = await Schedule.findByPk(offering_schedule_id);
      if (!offeringSchedule) return ctx.throw(404, 'Offering schedule not found');

      if (offeringSchedule.owner_group_id !== fromGroup)
        return ctx.throw(403, 'You can only offer schedules you own');
    }

    const now = new Date();
    const proposalUuid = uuidv4();

    const proposal = await ExchangeProposal.create({
      auction_id: auction.id,
      auction_uuid: auction.auction_uuid,
      proposal_uuid: proposalUuid,
      from_group_id: fromGroup,
      to_group_id: toGroup,
      offering_schedule_id: offeringSchedule ? offeringSchedule.id : null,
      message: message || null,
      status: 'PENDING',
      created_at: now,
      updated_at: now,
    });

    // Enviar evento PROPOSAL al broker
    const event = {
      auction_id: auction.auction_uuid,
      proposal_id: proposalUuid,
      url: offeringSchedule ? offeringSchedule.property_url : "",
      timestamp: now.toISOString(),
      quantity: 1,
      group_id: fromGroup,
      operation: "proposal",
    };

    await sendAuctionEvent(event);

    ctx.status = 201;
    ctx.body = { proposal };
  }
);

router.post(
  '/admin/proposals/:id/accept',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const proposalId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(proposalId)) return ctx.throw(400, 'Invalid proposal ID');

    const proposal = await ExchangeProposal.findByPk(proposalId);
    if (!proposal) return ctx.throw(404, 'Proposal not found');

    if (proposal.status !== 'PENDING')
      return ctx.throw(409, 'Proposal already resolved');

    const adminUser = ctx.state.dbUser || (await getOrCreateUserFromToken(ctx.state.user));
    const myGroup = getGroupId(adminUser);

    if (proposal.to_group_id !== myGroup)
      return ctx.throw(403, 'Proposal not addressed to you');

    const auction = await Auction.findByPk(proposal.auction_id);
    const schedule = await Schedule.findByPk(auction.schedule_id);

    const now = new Date();

    await proposal.update({ status: 'ACCEPTED', updated_at: now });
    await auction.update({ status: 'CLOSED', updated_at: now });

    // Cambiar propiedad del scheduling
    await schedule.update({
      owner_group_id: proposal.from_group_id,
      status: 'OWNED',
      updated_at: now,
    });

    // Si había schedule ofrecido, intercambiar
    if (proposal.offering_schedule_id) {
      const offer = await Schedule.findByPk(proposal.offering_schedule_id);
      if (offer) {
        await offer.update({ owner_group_id: myGroup, updated_at: now });
      }
    }

    // 🔥 Evento ACCEPT
    const event = {
      auction_id: auction.auction_uuid,
      proposal_id: proposal.proposal_uuid,
      url: schedule.property_url,
      timestamp: now.toISOString(),
      quantity: 1,
      group_id: myGroup,
      operation: "acceptance",
    };

    await sendAuctionEvent(event);

    ctx.body = {
      message: 'Proposal accepted',
      proposal,
      auction,
    };
  }
);

router.post(
  '/admin/proposals/:id/reject',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const proposalId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(proposalId)) return ctx.throw(400, 'Invalid proposal ID');

    const proposal = await ExchangeProposal.findByPk(proposalId);
    if (!proposal) return ctx.throw(404, 'Proposal not found');

    if (proposal.status !== 'PENDING')
      return ctx.throw(409, 'Proposal already resolved');

    const adminUser = ctx.state.dbUser ||
      (await getOrCreateUserFromToken(ctx.state.user));
    const myGroup = getGroupId(adminUser);

    if (proposal.to_group_id !== myGroup)
      return ctx.throw(403, 'Proposal not addressed to you');

    const now = new Date();

    await proposal.update({ status: 'REJECTED', updated_at: now });

    // 🔥 Evento REJECTION
    const event = {
      auction_id: proposal.auction_uuid,
      proposal_id: proposal.proposal_uuid,
      url: "",
      timestamp: now.toISOString(),
      quantity: 1,
      group_id: myGroup,
      operation: "rejection",
    };

    await sendAuctionEvent(event);

    ctx.body = {
      message: 'Proposal rejected',
      proposal,
    };
  }
);

router.get(
  '/admin/auctions',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const adminUser = ctx.state.dbUser ||
      (await getOrCreateUserFromToken(ctx.state.user));
    const myGroup = getGroupId(adminUser);

    const auctions = await Auction.findAll({
      where: { owner_group_id: myGroup },
      include: [
        {
          model: Schedule,
          as: 'schedule',
        }
      ],
      order: [['created_at', 'DESC']],
    });

    ctx.body = {
      auctions,
    };
  }
);

router.get(
  '/admin/proposals',
  requireAuth,
  requireAdmin,
  async (ctx) => {
    const adminUser = ctx.state.dbUser ||
      (await getOrCreateUserFromToken(ctx.state.user));
    const myGroup = getGroupId(adminUser);

    const proposals = await ExchangeProposal.findAll({
      where: {
        to_group_id: myGroup,  // propuestas dirigidas a mí
      },
      include: [
        {
          model: Auction,
          as: 'auction',
          include: [{ model: Schedule, as: 'schedule' }]
        },
        {
          model: Schedule,
          as: 'offering_schedule'
        }
      ],
      order: [['created_at', 'DESC']]
    });

    ctx.body = { proposals };
  }
);

router.get("/admin/schedules/mine", requireAuth,requireAdmin, async (ctx) => {
  try {
    const groupIdHeader = ctx.request.headers["x-group-id"];

    const groupId = Number(groupIdHeader);

    if (!groupId || isNaN(groupId)) {
      ctx.status = 400;
      ctx.body = { error: "Invalid or missing group_id" };
      return;
    }

    const schedules = await Schedule.findAll({
      where: { owner_group_id: groupId },
    });

    ctx.status = 200;
    ctx.body = { schedules };
  } catch (err) {
    console.error("Error GET /schedules/mine:", err);
    ctx.status = 500;
    ctx.body = { error: "Internal server error", details: err.message };
  }
});
// -------- PUBLIC
router.get('/workers/heartbeat', async (ctx) => {
  const t0 = Date.now();
  try {
    const res = await _fetch(`${process.env.JOB_MASTER_URL}/heartbeat`, {
      headers: { Authorization: `Bearer ${process.env.JOB_MASTER_TOKEN}` },
    });
    const ok = res.ok;
    const t1 = Date.now();
    let latency = t1 - t0;
    try {
      const json = await res.json();
      if (json && typeof json.latency_ms === 'number') latency = json.latency_ms;
    } catch {
      /* ignore */
    }
    ctx.body = { ok, latency_ms: latency };
  } catch (err) {
    const t1 = Date.now();
    console.error('Error during heartbeat check:', err.message);
    ctx.status = 200;
    ctx.body = {
      ok: false,
      latency_ms: t1 - t0,
      error: `Failed to reach job master: ${err.message}`,
    };
  }
});

/* ================================================================= */
/* ============= RECOMENDACIONES (Usando Servicio Real) ============ */
/* ================================================================= */

// Jobs en memoria (mínimo viable)
// job_id -> { status: 'QUEUED'|'RUNNING'|'DONE'|'ERROR', result?, error? }
const recJobs = new Map();

// =================================================================
// ❌ ELIMINADAS LAS FUNCIONES ANTIGUAS Y CON BUG:
// - fetchCatalogFromDb
// - scoreProperties
// - computeRealRecommendations
// =================================================================

// POST /recommendations/queue → encola y calcula en background (in-memory)
// ✅ ACTUALIZADO para usar runRecommendationJob (el servicio avanzado)
router.post('/recommendations/queue', requireAuth, async (ctx) => {
  try {
    // opcional: garantizar existencia del usuario
    await getOrCreateUserFromToken(ctx.state.user || {});
    
    const { top_n = 8, filter = {} } = ctx.request.body || {};
    const job_id = uuidv4();

     // --- PREPARAR CONTEXTO PARA EL JOB ---
     // El token JWT del usuario (sin 'Bearer ')
     const token = ctx.request.headers.authorization?.split(' ')[1] || '';
     if (!token) {
       ctx.status = 401;
       ctx.body = { error: 'Could not extract user token for recommendation job' };
       return;
     }

     // La URL base de ESTA MISMA API, que el worker llamará
     const apiBaseUrl = (
      process.env.PUBLIC_API_BASE_URL || 
       process.env.API_BASE_URL || 
       `http://localhost:${process.env.APP_PORT || 3000}`
    ).replace(/\/$/, ''); // Asegura que no tenga / al final

    recJobs.set(job_id, { status: 'QUEUED' });

    (async () => {
      recJobs.set(job_id, { status: 'RUNNING' });
      try {
        // --- ESTA ES LA LLAMADA CORRECTA ---
        // Llama al servicio avanzado importado
        const result = await runRecommendationJob(
          { top_n, filter },      // params
          { apiBaseUrl, token }   // context
        );
        recJobs.set(job_id, { status: 'DONE', result });
      } catch (e) {
        console.error(`[RECS JOB ${job_id}] FAILED:`, e); // Loguear el error real
        recJobs.set(job_id, { status: 'ERROR', error: e?.message || 'Worker error' });
      }
    })();

    ctx.status = 202;
    ctx.body = { job_id };
  } catch (err) {
    console.error('queue error:', err);
    ctx.status = 500;
    ctx.body = { error: 'Queue error', details: err?.message };
  }
});

// GET /recommendations/status/:job_id  → devuelve { job: { status, result?, error? } }
router.get('/recommendations/status/:job_id', requireAuth, async (ctx) => {
  const { job_id } = ctx.params;
  const job = recJobs.get(job_id);
  if (!job) {
    ctx.status = 404;
    ctx.body = { error: 'Job not found' };
    return;
  }
  ctx.body = { job };
});

/* =================== FIN RECOMMENDATIONS =================== */

// -------- PROTECTED (resto)
router.get('/me', requireAuth, async (ctx) => {
  try {
    const user = await getOrCreateUserFromToken(ctx.state.user || {});
    ctx.body = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
      auth0_user_id: user.auth0_user_id,
      is_admin: Boolean(user.is_admin),
      group_id: user.group_id ?? null,
    };
  } catch (err) {
    console.error('Error in /me route:', err);
    ctx.status = err.message.includes('sub claim') ? 400 : 500;
    ctx.body = {
      error: 'Could not retrieve user profile',
      message: err.message,
    };
  }
});

// ---- PROPERTIES
router.post('/properties', requireAuth, async (ctx) => {
  try {
    const { isValid, errors, value: propertyData } = validatePropertyPayload(
      ctx.request.body
    );
    if (!isValid) {
      console.warn(
        `Invalid property payload received: ${errors.join(', ')}`,
        ctx.request.body
      );
      ctx.status = 400;
      ctx.body = { error: 'Invalid property payload', details: errors };
      return;
    }

    let reservationCost = await computeReservationCost(propertyData);
    if (reservationCost === null) {
      console.warn(
        `⚠️ Could not compute reservation cost for ${propertyData.url}, proceeding without it.`
      );
    }

    const existingProperty = await Property.findOne({
      where: sequelize.where(
        sequelize.json('data.url'),
        propertyData.url
      ),
    });

    if (existingProperty) {
      const updates = {
        visits: sequelize.literal('visits + 1'),
        updated_at: propertyData.timestamp,
      };
      if (reservationCost !== null)
        updates.reservation_cost = reservationCost;
      await existingProperty.update(updates);
      console.log(
        `📈 Visit incremented for property: ${propertyData.url}`
      );
      ctx.body = await Property.findByPk(existingProperty.id);
      ctx.status = 200;
    } else {
      const newProperty = await Property.create({
        data: propertyData,
        visits: 1,
        updated_at: propertyData.timestamp,
        reservation_cost: reservationCost,
      });
      console.log(
        `✨ New property created: ${propertyData.url} with ID ${newProperty.id}`
      );
      ctx.body = newProperty;
      ctx.status = 201;
    }
  } catch (err) {
    console.error('Error inserting/updating property:', err);
    ctx.status = 500;
    ctx.body = {
      error: 'Internal server error processing property',
    };
  }
});

router.get('/properties', async (ctx) => {
      try {
        const { page = 1, limit = 25, price, location, date, currency } =
          ctx.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        if (
          isNaN(pageNum) ||
          pageNum < 1 ||
          isNaN(limitNum) ||
          limitNum < 1
        ) {
          ctx.status = 400;
          ctx.body = {
            error:
              "Invalid pagination parameters: 'page' and 'limit' must be positive integers.",
          };
          return;
        }
        const offset = (pageNum - 1) * limitNum;

        const whereClauses = {};
        const andConditions = [];

        if (price) {
          const priceValue = parseFloat(price);
          if (!isNaN(priceValue)) {
            andConditions.push(
              sequelize.where(
                sequelize.cast(
                  sequelize.json('data.price'),
                  'numeric'
                ),
                { [Op.lte]: priceValue }
              )
            );
            andConditions.push(
              sequelize.where(
                sequelize.json('data.currency'),
                currency && currency.toUpperCase() === 'UF' ? 'UF' : 'CLP'
              )
            );
          } else {
            console.warn(`Invalid price filter value received: ${price}`);
          }
        }

        if (location) {
          const searchTerm = String(location)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
          if (searchTerm) {
            andConditions.push(
              sequelize.where(
                sequelize.fn(
                  'unaccent',
                  sequelize.fn(
                    'lower',
                    sequelize.json('data.location')
                  )
                ),
                { [Op.like]: `%${searchTerm}%` }
              )
            );
          }
        }

        if (date) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            andConditions.push(
              sequelize.where(
                sequelize.fn(
                  'DATE',
                  sequelize.cast(
                    sequelize.json('data.timestamp'),
                    'timestamp with time zone'
                  )
                ),
                date
              )
            );
          } else {
            console.warn(
              `Invalid date filter value received (expected YYYY-MM-DD): ${date}`
            );
          }
        }

        if (andConditions.length > 0)
          whereClauses[Op.and] = andConditions;

        const { count, rows: properties } =
          await Property.findAndCountAll({
            where: whereClauses,
            order: [
              ['updated_at', 'DESC'],
              [
                sequelize.cast(
                  sequelize.json('data.timestamp'),
                  'timestamp with time zone'
                ),
                'DESC',
              ],
            ],
            limit: limitNum,
            offset,
          });

        ctx.body = {
          totalItems: count,
          totalPages: Math.ceil(count / limitNum),
          currentPage: pageNum,
          properties,
        };
      } catch (err) {
        console.error('Error fetching properties:', err);
        ctx.status = 500;
        ctx.body = {
          error: 'Internal server error fetching properties',
        };
      }
});

router.get('/properties/:id', async (ctx) => {
  const { id } = ctx.params;
  const propertyId = parseInt(id, 10);
  if (isNaN(propertyId) || propertyId < 1) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid property ID.' };
    return;
  }

  try {
    const property = await Property.findByPk(propertyId);
    if (!property) {
      ctx.status = 404;
      ctx.body = { error: 'Property not found' };
      return;
    }
    ctx.body = property;
  } catch (err) {
    console.error(
      `Error fetching property ${propertyId}:`,
      err
    );
    ctx.status = 500;
    ctx.body = {
      error: 'Internal server error fetching property details',
    };
  }
});

// ---- BUY (Webpay)
router.post('/properties/buy', requireAuth, requireAdmin, async (ctx) => {

        const { url } = ctx.request.body;

        if (!url || typeof url !== 'string' || url.trim() === '') {
          ctx.status = 400;
          ctx.body = {
            error: "Valid 'url' is required in the request body",
          };
          return;
        }
        const cleanUrl = url.trim();

        let user;
        let reservation_cost;
        let property;
        let requestId = uuidv4();
        let buyOrder = `G9-${requestId.substring(0, 23)}`;

        const transaction = await sequelize.transaction();

        try {
          console.log(
            `🔄 [${requestId}] Processing buy request for URL: ${cleanUrl}`
          );

          try {
            user = await getOrCreateUserFromToken(ctx.state.user || {});
          } catch (err) {
            console.error(
              `❌ [${requestId}] Invalid token payload:`,
              err.message
            );
            ctx.status = 400;
            ctx.body = {
              error: 'Invalid token payload',
              message: err.message,
            };
            await transaction.rollback();
            return;
          }
          console.log(` -> User ID: ${user.id}`);

          property = await Property.findOne({
            where: sequelize.where(
              sequelize.json('data.url'),
              cleanUrl
            ),
            lock: transaction.LOCK.UPDATE,
            transaction,
          });
          if (!property) {
            console.warn(
              `❌ [${requestId}] Property not found for URL: ${cleanUrl}`
            );
            ctx.status = 404;
            ctx.body = {
              error: 'Property not found for the given URL',
            };
            await transaction.rollback();
            return;
          }
          console.log(
            ` -> Property ID: ${property.id}, Visits: ${property.visits}`
          );

          if (property.visits <= 0) {
            console.warn(
              `❌ [${requestId}] No visits available for property ${property.id}`
            );
            ctx.status = 409;
            ctx.body = {
              error:
                'No visits available for this property. It might have been reserved already.',
            };
            await transaction.rollback();
            return;
          }

          if (!property.data) {
            throw new Error(
              `Property ${property.id} found but has no data field`
            );
          }
          reservation_cost = await computeReservationCost(property.data);
          if (reservation_cost === null || reservation_cost <= 0) {
            console.error(
              `❌ [${requestId}] Invalid reservation cost for ${cleanUrl}: ${reservation_cost}`
            );
            throw new Error(
              'Could not compute a valid reservation cost (must be > 0)'
            );
          }
          console.log(
            ` -> Reservation Cost: ${reservation_cost} CLP`
          );

          if (!WEBPAY_RETURN_URL) {
            console.error(
              '❌ FATAL: WEBPAY_RETURN_URL is not set!'
            );
            throw new Error(
              'Server configuration error: Webpay return URL missing.'
            );
          }
          try {
            new URL(WEBPAY_RETURN_URL);
          } catch {
            throw new Error(
              'WEBPAY_RETURN_URL must be an absolute URL'
            );
          }

          console.log(
            `[DEBUG] Usando WEBPAY_RETURN_URL: ${WEBPAY_RETURN_URL}`
          );
          console.log(
            `⏳ [${requestId}] Creating Webpay transaction buyOrder=${buyOrder}, amount=${reservation_cost}, returnUrl=${WEBPAY_RETURN_URL}`
          );

          const tx = await createTransaction(
            buyOrder,
            `user-${user.id}`,
            reservation_cost,
            WEBPAY_RETURN_URL
          );
          console.log(
            `💳 [${requestId}] Webpay transaction created: token=${tx.token}`
          );

          await Request.create(
            {
              request_id: requestId,
              buy_order: buyOrder,
              user_id: user.id,
              property_url: cleanUrl,
              amount_clp: reservation_cost,
              status: 'PENDING',
              deposit_token: tx.token,
              retry_used: false,
            },
            { transaction }
          );
          console.log(
            `💾 [${requestId}] Purchase request saved locally with status PENDING.`
          );

          await property.decrement('visits', { transaction });
          console.log(
            `🔽 [${requestId}] Visit decremented for property: ${cleanUrl}`
          );

          await transaction.commit();
          console.log(
            `✅ [${requestId}] DB Transaction committed.`
          );

          try {
            const mqttPayload = await sendPurchaseRequest(
              cleanUrl,
              reservation_cost,
              user.id,
              tx.token,
              requestId,
              buyOrder
            );
            console.log(
              `📤 [${requestId}] Buy request sent via MQTT. Payload:`,
              mqttPayload
            );
          } catch (mqttError) {
            console.error(
              `⚠️ [${requestId}] Failed to send purchase request via MQTT after DB commit:`,
              mqttError
            );
          }

          ctx.status = 200;
          ctx.body = {
            message: 'Solicitud iniciada, redirigiendo a Webpay...',
            webpay_url: tx.url,
            webpay_token: tx.token,
            request_id: requestId,
            buy_order: buyOrder,
          };
        } catch (err) {
          if (transaction && !transaction.finished) {
            console.warn(
              `[${requestId}] Rolling back DB transaction due to error.`
            );
            await transaction.rollback();
          }
          try {
        // Buscar la request que podría haber quedado en PENDING
        const reqRow = await Request.findOne({ where: { request_id: requestId } });

        if (reqRow && reqRow.status === 'PENDING') {
          await reqRow.update({
            status: 'REJECTED',
            reason: 'Internal Webpay error',
            updated_at: new Date()
          });

          // Restaurar visita
          const prop = await Property.findOne({
                where: sequelize.where(sequelize.json('data.url'), cleanUrl)
              });

              if (prop) {
                await prop.increment('visits');
                console.log(`✔️ Restored visit for property ${cleanUrl}`);
              }
            }
          } catch (e2) {
            console.error('❌ Error while cleaning failed transaction:', e2.message);
          }

          console.error(
            `❌ Critical Error in /properties/buy for request ${requestId}:`,
            {
              message: err.message,
              stack: err.stack,
              url: cleanUrl,
              userId: user ? user.id : 'N/A',
              calculated_cost: reservation_cost,
            }
          );

          ctx.status = err.status || 500;
          ctx.body = {
            error: 'Error processing purchase request',
            details: err.message,
            request_id: requestId,
          };
        }
});

// ---- RESERVATIONS LIST
router.get('/reservations', requireAuth, async (ctx) => {
  let user;
  try {
      if (!ctx.state.user) {
        ctx.status = 401;
        ctx.body = { error: "No auth token found" };
        return;
      }
      user = await getOrCreateUserFromToken(ctx.state.user);
  } catch (err) {
    ctx.status = 400;
    ctx.body = {
      error: `Invalid token payload or failed to retrieve user ${ctx.state.user || {}}`,
      message: err.message,
    };
    return;
  }

  try {
    const reservations = await Request.findAll({
      where: { user_id: user.id },
      order: [['created_at', 'DESC']],
    });

    // respondemos con invoice_url también
    ctx.body = reservations.map(r => {
      const plain = r.toJSON();
      return {
        request_id: plain.request_id,
        status: plain.status,
        reason: plain.reason,
        retry_used: plain.retry_used,
        amount_clp: plain.amount_clp,
        property_url: plain.property_url,
        created_at: plain.created_at,
        invoice_url: plain.invoice_url || null,
      };
    });
  } catch (err) {
    console.error(`Error fetching reservations for user ${user.id}:`, err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error fetching reservations' };
  }
});

// ---- RESERVATION DETAIL
router.get('/reservations/:request_id', requireAuth,async (ctx) => {
  const { request_id } = ctx.params;
  if (!request_id || !uuidValidate(request_id)) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid or missing request_id UUID' };
    return;
  }

  let user;
  try {
    user = await getOrCreateUserFromToken(ctx.state.user || {});
  } catch (err) {
    ctx.status = 400;
    ctx.body = {
      error: 'Invalid token payload or failed to retrieve user',
      message: err.message,
    };
    return;
  }

  try {
    const reservationRequest = await Request.findOne({
      where: { request_id, user_id: user.id },
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

    const plain = reservationRequest.toJSON();

    ctx.body = {
      status: plain.status,
      reason: plain.reason,
      retry_used: plain.retry_used,
      invoice_url: plain.invoice_url || null,
      reservation_details: plain,
      property_details: property ? property.toJSON() : null,
    };
    ctx.status = 200;
  } catch (err) {
    console.error(`❌ Error fetching details for reservation request ${request_id}:`, err);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error fetching reservation details' };
  }
});

// ---- RETRY RESERVATION
router.post(
  '/reservations/:request_id/retry',
  requireAuth,
  async (ctx) => {
    const { request_id } = ctx.params;

    if (!request_id || !uuidValidate(request_id)) {
      ctx.status = 400;
      ctx.body = {
        error: 'Invalid or missing request_id UUID',
      };
      return;
    }

    let user;
    try {
      user = await getOrCreateUserFromToken(ctx.state.user || {});
    } catch (err) {
      ctx.status = 400;
      ctx.body = {
        error:
          'Invalid token payload or failed to retrieve user',
        message: err.message,
      };
      return;
    }

    const transaction = await sequelize.transaction();
    try {
      const request = await Request.findOne({
        where: { request_id },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });

      if (!request) {
        ctx.status = 404;
        ctx.body = { error: 'Request not found' };
        await transaction.rollback();
        return;
      }
      if (request.user_id !== user.id) {
        ctx.status = 403;
        ctx.body = {
          error: 'Forbidden: You do not own this request',
        };
        await transaction.rollback();
        return;
      }
      const status = String(request.status || '').toUpperCase();
      if (!['ERROR', 'REJECTED'].includes(status)) {
        ctx.status = 400;
        ctx.body = {
          error: `Only failed requests (ERROR, REJECTED) can be retried. Current status: ${status}`,
        };
        await transaction.rollback();
        return;
      }
      if (request.retry_used) {
        ctx.status = 409;
        ctx.body = {
          error: 'Retry already used for this request',
        };
        await transaction.rollback();
        return;
      }

      console.log(
        `🔄 Retrying request ${request_id}. Republishing to MQTT...`
      );
      const mqttPayload =
        await republishPurchaseRequest(request);
      console.log(
        `📤 Republished payload for ${request_id}:`,
        mqttPayload
      );

      await request.update(
        {
          retry_used: true,
          status: 'PENDING',
          reason: 'Retry initiated via API',
          updated_at: new Date(),
        },
        { transaction }
      );

      await transaction.commit();

      ctx.body = {
        message: 'Request retry initiated successfully',
        request: request.toJSON(),
      };
    } catch (err) {
      await transaction.rollback();
      console.error(
        `❌ Error retrying request ${request_id}:`,
        err
      );
      ctx.status = err.status || 500;
      ctx.body = {
        error:
          'Internal server error during retry process',
        details: err.message,
      };
    }
  }
);

// ---- Helpers internos para Webpay Return ----

// publicar validación al tópico MQTT SOLO si ya no está "PENDING"
async function publishValidationSafe(reqRow) {
  if (!reqRow) return;
  const finalStatus = String(reqRow.status || '').toUpperCase();
  if (finalStatus === 'PENDING') return; // sólo si ya está resuelto

  try {
    await publishValidation({
      group_id: Number(process.env.GROUP_ID || 0),
      request_id: reqRow.request_id,
      buy_order: reqRow.buy_order,
      status: finalStatus,
      reason: reqRow.reason,
      amount_clp: reqRow.amount_clp,
      property_url: reqRow.property_url,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('MQTT publishValidation failed:', e.message);
  }
}

async function ensureInvoiceForRequestRow(requestRow) {
  try {
    if (!requestRow) return;
    if (String(requestRow.status || '').toUpperCase() !== 'ACCEPTED') return;

    // Si ya hay URL, intenta HEAD; si expiró, regeneras
    if (requestRow.invoice_url) {
      try {
        const head = await (global.fetch || require('undici').fetch)(requestRow.invoice_url, { method: 'HEAD' });
        if (head.ok) return;
      } catch { /* expirada → sigue */ }
    }

    const buyer = await User.findByPk(requestRow.user_id);
    const property = await Property.findOne({
      where: sequelize.where(sequelize.json('data.url'), requestRow.property_url),
    });

    const { url } = await generarBoletaDesdeApiGateway({ requestRow, user: buyer, property });
    if (url) await requestRow.update({ invoice_url: url });
  } catch (e) {
    console.error('ensureInvoiceForRequestRow (serverless):', e.message);
  }
}

// ---- WEBPAY RETURN

// POST /payments/webpay/return - Webpay vuelve con form POST (token_ws)
router.post(
  '/payments/webpay/return',
  koaBody({ urlencoded: true, json: false, multipart: false }),
  async (ctx) => {
    try {
      console.log("🔥 ENTRE A POST RETURN");

      const token = ctx.request.body?.token_ws;
      if (!token) {
        ctx.status = 400;
        ctx.body = 'Missing token_ws';
        return;
      }

      // 1) Confirmar/commit en Webpay
      const result = await commitTransaction(token);
      const mapped = mapWebpayStatus(result);

      // 2) Actualizar DB
      const t = await sequelize.transaction();
      let requestRow = null;

      try {
        requestRow = await Request.findOne({
          where: { deposit_token: token },
          lock: t.LOCK.UPDATE,
          transaction: t
        });
        console.log('🔔 POST /payments/webpay/return: Found requestRow: AAAA', requestRow);
        if (requestRow) {
          const reason = (result && result.response_code === 0)
            ? 'Webpay payment approved'
            : `Webpay payment failed/rejected (Code: ${result?.response_code}, Status: ${result?.status})`;

          await requestRow.update(
            { status: mapped, reason, updated_at: new Date() },
            { transaction: t }
          );
          console.log('🔔 POST /payments/webpay/return: Found requestRow:', requestRow.status);
          // ==================================================
          // 3) CREAR SCHEDULE SI PAGO ES ACCEPTED
          //    NO revisamos admin porque esta ruta solo
          //    ocurre si /properties/buy ya estaba protegido
          // ==================================================
          console.log(`🔔 Processing post-payment for request ${requestRow.request_id} with status ${mapped}`);
          if (mapped === 'ACCEPTED') {
            console.log(`✅ Payment ACCEPTED for request ${requestRow.request_id}. Checking/creating PropertySchedule...`);
            console.log("requestRow", requestRow);
            console.log("user_id", requestRow.user_id);
            await Schedule.create(
              {
                property_url: requestRow.property_url,
                price_clp: requestRow.amount_clp,
                discount_pct: 0,
                status: 'OWNED',  // inventario del admin
                created_by: requestRow.user_id,
                owner_group_id: 9 // o el grupo si lo manejas
              },
              { transaction: t }
            );
            console.log(
              `🟢 Schedule creado para propiedad ${requestRow.property_url}`
            );
          }
        } else {
          console.error(`POST /payments/webpay/return: No request found for token ${token}`);
        }

        await t.commit();
      } catch (e) {
        try { await t.rollback(); } catch {}
        throw e;
      }

      // 4) Generar boleta si ACCEPTED
      if (requestRow) {
        await ensureInvoiceForRequestRow(requestRow);
      }

      // 5) Enviar validación vía MQTT
      if (requestRow) {
        try {
          await publishValidation({
            group_id: Number(process.env.GROUP_ID || 0),
            request_id: requestRow.request_id,
            buy_order: requestRow.buy_order,
            status: String(requestRow.status || mapped || 'PENDING').toUpperCase(),
            reason: requestRow.reason,
            amount_clp: requestRow.amount_clp,
            property_url: requestRow.property_url,
            timestamp: new Date().toISOString()
          });
        } catch (pubErr) {
          console.error('MQTT publishValidation failed:', pubErr.message);
        }
      }

      // 6) Redirigir al front
      const requestId = requestRow ? requestRow.request_id : 'unknown';
      const statusParam = (mapped === 'ACCEPTED') ? 'ok' : 'failed';
      const url = `${FRONT}/reservations/${requestId}?status=${statusParam}`;
      ctx.status = 302;
      ctx.redirect(url);

    } catch (e) {
      console.error('❌ Error en POST /payments/webpay/return:', e);
      const url = `${FRONT}/reservations?status=failed`;
      ctx.status = 302;
      ctx.redirect(url);
    }
  }
);


// GET /payments/webpay/return - cancel/timeout o fallback con token_ws
router.get('/payments/webpay/return', async (ctx) => {
  const { token_ws, TBK_TOKEN, TBK_ORDEN_COMPRA } = ctx.query;
  console.log(
    'PAYMENT RETURN (GET): Received query params:',
    ctx.query
  );
  console.log("🔥 ENTRE A GET RETURN");

  const redirectBase = `${FRONT}/reservations`;

  // helper para mapear a query del front
  const toQuery = (status) => {
    const s = String(status || 'PENDING').toUpperCase();
    if (s === 'ACCEPTED') return 'ok';
    if (s === 'PENDING') return 'processing';
    return 'failed';
  };

  try {
    // ---- Fallback: GET con token_ws (poco común)
    if (token_ws) {
      const t = await sequelize.transaction();
      let reqRow = null;
      try {
        reqRow = await Request.findOne({
          where: { deposit_token: token_ws },
          lock: t.LOCK.UPDATE,
          transaction: t,
        });

        if (reqRow) {
          // si sigue PENDING, intentamos confirmar aquí (idempotente)
          if (String(reqRow.status).toUpperCase() === 'PENDING') {
            try {
              const result = await commitTransaction(token_ws);
              const mapped = mapWebpayStatus(result);
              const reason =
                result && result.response_code === 0
                  ? 'Webpay payment approved (GET fallback)'
                  : `Webpay payment failed/rejected (GET fallback) (Code: ${result?.response_code}, Status: ${result?.status})`;

              await reqRow.update(
                {
                  status: mapped,
                  reason,
                  updated_at: new Date(),
                },
                { transaction: t }
              );
              // === CREAR SCHEDULE SI EL PAGO FUE ACCEPTED ===
              if (mapped === 'ACCEPTED') {
                console.log(`🔧 GET fallback: creating schedule for property ${reqRow.property_url}`);

                await Schedule.create(
                  {
                    property_url: reqRow.property_url,
                    price_clp: reqRow.amount_clp,
                    discount_pct: 0,
                    status: 'OWNED',  // inventario del admin
                    created_by: reqRow.user_id,
                    owner_group_id: 9
                  },
                  { transaction: t }
                );

                console.log(`🟢 GET fallback: schedule created for ${reqRow.property_url}`);
              }

              // restaurar visitas si fue REJECTED/ERROR
              if (
                mapped === 'REJECTED' ||
                mapped === 'ERROR'
              ) {
                const prop = await Property.findOne({
                  where: sequelize.where(
                    sequelize.json('data.url'),
                    reqRow.property_url
                  ),
                  lock: t.LOCK.UPDATE,
                  transaction: t,
                });
                if (prop)
                  await prop.increment('visits', {
                    transaction: t,
                  });
              }
            } catch (e) {
              console.error(
                'GET /payments/webpay/return: fallback commit failed:',
                e
              );
              // dejamos el estado como esté (probablemente PENDING)
            }
          }

          await t.commit();
        } else {
          await t.commit();
          const url = `${redirectBase}?status=failed&reason=RequestNotFoundForToken`;
          ctx.status = 302;
          ctx.redirect(url);
          return;
        }
      } catch (err) {
        try {
          await t.rollback();
        } catch {}
        throw err;
      }

      // publicar validación si ya no está PENDING
      await publishValidationSafe(reqRow);

      // generar boleta con Lambda si ACCEPTED
      await ensureInvoiceForRequestRow(reqRow);

      // redirigir al front
      const finalStatus = String(reqRow.status || 'PENDING').toUpperCase();
      const url = `${redirectBase}/${reqRow.request_id}?status=${toQuery(
        finalStatus
      )}`;
      ctx.status = 302;
      ctx.redirect(url);
      return;
    }

    // ---- Usuario canceló: TBK_TOKEN + TBK_ORDEN_COMPRA
    if (TBK_TOKEN && TBK_ORDEN_COMPRA) {
      const t = await sequelize.transaction();
      let reqRow = null;
      let url = `${redirectBase}?status=failed&reason=RequestNotFoundForOrder`;

      try {
        reqRow = await Request.findOne({
          where: { buy_order: TBK_ORDEN_COMPRA },
          lock: t.LOCK.UPDATE,
          transaction: t,
        });

        if (
          reqRow &&
          String(reqRow.status).toUpperCase() === 'PENDING'
        ) {
          await reqRow.update(
            {
              status: 'REJECTED',
              // CORRECTION: _reason -> reason
              reason: 'User cancelled payment at Webpay',
              updated_at: new Date(),
            },
            { transaction: t }
          );

          const property = await Property.findOne({
            where: sequelize.where(
              sequelize.json('data.url'),
              reqRow.property_url
            ),
            lock: t.LOCK.UPDATE,
            transaction: t,
          });
          if (property)
            await property.increment('visits', {
              transaction: t,
            });

          await t.commit();

          // publicar validación
          await publishValidationSafe(reqRow);

          url = `${redirectBase}/${reqRow.request_id}?status=failed&reason=UserCancelled`;
          ctx.status = 302;
          ctx.redirect(url);
          return;
        }

        // ... rest of the block ...
        if (reqRow) {
          // puede ya estar ACCEPTED o REJECTED
          await publishValidationSafe(reqRow);
          await ensureInvoiceForRequestRow(reqRow);

          url = `${redirectBase}/${reqRow.request_id}?status=${toQuery(
            reqRow.status
          )}&reason=AlreadyFinalized`;
        }

        ctx.status = 302;
        ctx.redirect(url);
        return;
      } catch (err) {
        try {
          await t.rollback();
        } catch {}
        throw err;
      }
    }

    // ---- Timeout/fallo sin TBK_TOKEN pero con orden
    if (TBK_ORDEN_COMPRA) {
      const reqRow = await Request.findOne({
        where: { buy_order: TBK_ORDEN_COMPRA },
      });

      let url = `${redirectBase}?status=failed&reason=RequestNotFoundForOrder`;
      if (reqRow) {
        await publishValidationSafe(reqRow);
        await ensureInvoiceForRequestRow(reqRow);

        url = `${redirectBase}/${reqRow.request_id}?status=${toQuery(
          reqRow.status
        )}`;
      }
      ctx.status = 302;
      ctx.redirect(url);
      return;
    }

    // Sin parámetros esperados
    ctx.status = 400;
    ctx.body = {
      error: 'Missing Webpay parameters in query string',
    };
  } catch (err) {
    console.error(
      '❌ Critical Error in GET /payments/webpay/return:',
      { message: err.message, stack: err.stack, query: ctx.query }
    );
    const url = `${redirectBase}?status=failed&reason=ServerError`;
    ctx.status = 302;
    ctx.redirect(url);
  }
});

// ---- Descargar/abrir boleta
// Ahora, en vez de servir un PDF local, redirigimos al S3 público.
// Si no existe todavía, intentamos generarla con Lambda.
router.get('/reservations/:request_id/invoice', requireAuth, async (ctx) => {
  const { request_id } = ctx.params;

  const user = await getOrCreateUserFromToken(ctx.state.user || {});
  const reqRow = await Request.findOne({
    where: { request_id, user_id: user.id },
  });
  if (!reqRow) {
    ctx.status = 404;
    ctx.body = {
      error:
        'Reservation request not found or not owned by user',
    };
    return;
  }

  if (String(reqRow.status).toUpperCase() !== 'ACCEPTED') {
    ctx.status = 400;
    ctx.body = {
      error:
        'Invoice available only for ACCEPTED reservations',
    };
    return;
  }

  // asegurarnos de que exista invoice_url
  await ensureInvoiceForRequestRow(reqRow);
  await reqRow.reload(); // refresca invoice_url después del update

  if (!reqRow.invoice_url) {
    ctx.status = 500;
    ctx.body = {
      error: 'Invoice not available yet',
    };
    return;
  }

  ctx.status = 200;
  ctx.body = { url: reqRow.invoice_url };
});

// === NUEVO: helper interno para normalizar moneda a CLP ===
async function toClpAmount(price, currency, tsIso) {
  const c = (currency || '').toString().trim().toUpperCase();
  if (!Number.isFinite(Number(price))) return null;
  const p = Number(price);

  if (c === 'CLP' || c === '$' || c === '') return Math.round(p);

  if (c === 'UF') {
    try {
      const v = await getUfValue(tsIso || new Date().toISOString());
      if (!Number.isFinite(v) || v <= 0) return null;
      return Math.round(p * v);
    } catch {
      return null;
    }
  }

  // Moneda desconocida → no convertible
  return null;
}

// === NUEVO: expone UF para el worker ===
// GET /utils/uf?date=ISO_8601
router.get('/utils/uf', requireAuth, async (ctx) => {
  try {
    const date = (ctx.query?.date && String(ctx.query.date)) || new Date().toISOString();
    const val = await getUfValue(date);
    if (!Number.isFinite(val) || val <= 0) {
      ctx.status = 502;
      ctx.body = { error: 'UF unavailable' };
      return;
    }
    ctx.body = { uf: val, date };
  } catch (e) {
    ctx.status = 500;
    ctx.body = { error: 'UF error', message: e.message };
  }
});

// ✅ Reemplaza/añade en tu Koa (web_server) — por ejemplo en app.js donde defines rutas protegidas
router.get('/users/preferences', requireAuth, async (ctx) => {
  try {
    const user = await getOrCreateUserFromToken(ctx.state.user || {});

    // 1) Traer RESERVAS del usuario (últimos 18 meses para tener suficiente muestra)
    const since = new Date();
    since.setMonth(since.getMonth() - 18);

    const requests = await Request.findAll({
      where: {
        user_id: user.id,
        created_at: { [Op.gte]: since },
        status: { [Op.in]: ['ACCEPTED', 'PENDING'] } // usa solo ACCEPTED si prefieres ultra-estricto
      },
      order: [['created_at', 'DESC']]
    });

    // Si no hay historial, devolvemos mínimos datos y sin top_locations
    if (!requests.length) {
      ctx.body = {
        price_clp_p25: null,
        price_clp_median: null,
        price_clp_p75: null,
        top_locations: [] // <- clave: SIN fallback del catálogo
      };
      return;
    }

    // 2) Mapear property_url -> Property (para sacar location / price / currency / timestamp)
    const urls = Array.from(new Set(requests.map(r => r.property_url).filter(Boolean)));
    const properties = await Property.findAll({
      where: sequelize.where(sequelize.json('data.url'), { [Op.in]: urls })
    });
    const byUrl = new Map();
    for (const p of properties) {
      const url = p?.data?.url;
      if (url) byUrl.set(url, p);
    }

    // 3) Recolectar CLP (convirtiendo UF cuando haga falta) y tokens de ubicación
    //    Para la conversión UF usamos tu servicio /utils/uf vía computeReservationCost o directamente getUfValue si prefieres.
    async function ufAt(tsIso) {
      try {
        const r = await _fetch(`${process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || `http://localhost:${process.env.APP_PORT || 3000}`}/utils/uf?date=${encodeURIComponent(tsIso || new Date().toISOString())}`, {
          headers: { Authorization: `Bearer ${ctx.request.headers.authorization?.split(' ')[1] || ''}` }
        });
        if (!r.ok) return null;
        const j = await r.json();
        const v = Number(j?.uf);
        return Number.isFinite(v) && v > 0 ? v : null;
      } catch { return null; }
    }

    async function priceToClp(p) {
      const d = p?.data || {};
      const price = Number(d?.price);
      if (!Number.isFinite(price) || price <= 0) return null;
      const ccy = (d?.currency || '').toString().toUpperCase();
      if (!ccy || ccy === 'CLP' || ccy === '$') return Math.round(price);
      if (ccy === 'UF') {
        const v = await ufAt(d?.timestamp);
        return (v && v > 0) ? Math.round(price * v) : null;
      }
      return null;
    }

    const STATIC_STOPWORDS = new Set([
      'calle','cll','av','avenida','pje','pasaje','blk','block','edif','edificio','dpto','depto',
      'casa','condominio','condo','sector','centro','norte','sur','oriente','poniente',
      'barrio','comuna','region','región','chile',
      'la','el','los','las','y','e','de','del','al','en','con','sin','por','para','a',
      's/n','sn','nº','num','numero','n°'
    ]);
    const normText = (s) => (s || '').toString().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s,.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const filteredTokens = (s) => {
      const arr = normText(s).split(/[,\s/|-]+/).filter(Boolean);
      const out = [];
      for (const t of arr) {
        if (t.length <= 1) continue;
        if (STATIC_STOPWORDS.has(t)) continue;
        out.push(t);
      }
      return out;
    };

    const clps = [];
    const tokenCounter = new Map(); // token -> count

    for (const r of requests) {
      const p = byUrl.get(r.property_url);
      if (!p) continue;
      const d = p.data || {};

      // precio CLP
      const clp = await priceToClp(p);
      if (Number.isFinite(clp) && clp > 0) clps.push(clp);

      // tokens ubicación
      const loc = (d.location || '').toString();
      for (const t of filteredTokens(loc)) {
        tokenCounter.set(t, (tokenCounter.get(t) || 0) + 1);
      }
    }

    // 4) Cuantiles de precio
    clps.sort((a,b)=>a-b);
    const quantile = (arr, q) => {
      if (!arr.length) return null;
      const pos = (arr.length - 1) * q;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      if (lo === hi) return arr[lo];
      const h = pos - lo;
      return Math.round(arr[lo] * (1 - h) + arr[hi] * h);
    };

    const price_clp_p25    = quantile(clps, 0.25);
    const price_clp_median = quantile(clps, 0.50);
    const price_clp_p75    = quantile(clps, 0.75);

    // 5) Top locaciones del USUARIO (tokens más frecuentes en su historial)
    const top_locations = Array.from(tokenCounter.entries())
      .sort((a,b)=>b[1]-a[1])
      .slice(0, 8)
      .map(([key, count]) => ({ key, count }));

    ctx.body = {
      price_clp_p25,
      price_clp_median,
      price_clp_p75,
      top_locations
    };
  } catch (err) {
    console.error('GET /users/preferences error:', err);
    ctx.status = 500;
    ctx.body = { error: 'Failed to compute user preferences' };
  }
});


// --- LOG ANTES DEL ROUTER
app.use(async (ctx, next) => {
  console.log(`--> ${ctx.method} ${ctx.path} (Antes de usar el Router)`);
  await next();
});

// Montaje del router
app.use(router.routes()).use(router.allowedMethods());

// --- LOG FINAL si no se manejó ruta
app.use(async (ctx) => {
  console.log(
    `--> ${ctx.method} ${ctx.path} (Fin cadena middleware - RUTA NO ENCONTRADA - Status: ${ctx.status})`
  );
  if (!ctx.status || ctx.status === 404) {
    ctx.status = 404;
    ctx.body = {
      error: 'Not Found',
      message: `The requested path ${ctx.path} was not found on this server.`,
    };
  }
});

// --- LISTEN ---
const PORT = process.env.APP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor web corriendo en puerto ${PORT}`);
});

// --- Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});
