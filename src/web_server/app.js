// Envía métricas solo si New Relic está configurado (evita crash en local)
try { require('newrelic'); } catch (e) { console.warn('New Relic not started:', e.message); }

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

// Imports
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
const { createTransaction, commitTransaction, mapWebpayStatus} = require("./services/webpayService");
const { getUfValue } = require('./services/ufService');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const { Op } = require('sequelize');
const { fetch: undiciFetch } = require('undici');
const _fetch = global.fetch || undiciFetch;

// Constants from environment variables
const JOB_MASTER_URL = process.env.JOB_MASTER_URL || "http://job-master:8080";
const JOB_MASTER_TOKEN = process.env.JOB_MASTER_TOKEN;
const WEBPAY_RETURN_URL = process.env.WEBPAY_RETURN_URL;    
const FRONTEND_URL = process.env.FRONTEND_URL; // Needed for Webpay redirection
const PUBLIC_FRONTEND_URL = process.env.PUBLIC_FRONTEND_URL;
const FRONT = PUBLIC_FRONTEND_URL || FRONTEND_URL || 'http://localhost:5173';

// Helper Functions
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


// Database Authentication and Schema Check
sequelize.authenticate()
  .then(async () => {
    console.log('Conexión exitosa a la base de datos con Sequelize');
    await ensureDbSchemaUpgrades();
  })
  .catch(err => console.error('Error de conexión con Sequelize:', err));

// Koa App Initialization
const Router = require('@koa/router');
const app = new Koa();

// --- LOGGING MIDDLEWARE (Inicio) ---
app.use(async (ctx, next) => {
    console.log(`--> ${ctx.method} ${ctx.path} (Inicio Request)`);
    await next();
    // Log after response is potentially set by later middleware
    console.log(`<-- ${ctx.method} ${ctx.path} (Fin Request - Status: ${ctx.status})`);
});


// --- CORS MIDDLEWARE ---
const buildCorsOptions = () => {
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);

    if (allowedOrigins.length === 0) {
        console.warn("⚠️ CORS_ALLOWED_ORIGINS not set, allowing all origins.");
        return { origin: '*' }; // Allow all if not specified
    }
    return {
        origin: ctx => {
            const requestOrigin = ctx.request.header.origin;
            if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
                return requestOrigin; // Reflect the allowed origin
            }
            console.warn(`🚫 CORS blocked origin: ${requestOrigin} (Not in allowed list: ${allowedOrigins.join(', ')})`);
            return undefined; // Let the middleware handle the rejection
        }
        // exposeHeaders: ['Content-Length', 'Date', 'ETag'], // Expose common headers
        // maxAge: 86400, // Cache preflight response for 1 day
        // credentials: true, // If you need to allow cookies/auth headers
    };
};
app.use(cors(buildCorsOptions()));

// --- BODY PARSING MIDDLEWARE ---
// Needs to run after CORS allows the request but before routes need the body
app.use(koaBody());

// --- AUTH0 JWT MIDDLEWARE (Definition) ---
const createAuthMiddleware = () => {
    const issuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
    const audience = process.env.AUTH0_AUDIENCE;

    if (!issuerBaseUrl || !audience) {
        console.error('❌ FATAL: Missing Auth0 configuration. Set AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE.');
        return async (ctx, next) => {
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
        // passthrough: true // Set to true if you want to allow non-authenticated access to some routes handled later
    });
};
const requireAuth = createAuthMiddleware();

// --- LOGGING MIDDLEWARE (Antes de OPTIONS handler) ---
app.use(async (ctx, next) => { console.log(`--> ${ctx.method} ${ctx.path} (Antes del handler OPTIONS)`); await next(); });

// --- OPTIONS REQUEST HANDLER ---
// Handles preflight requests BEFORE JWT validation attempts
app.use(async (ctx, next) => {
  if (ctx.method === 'OPTIONS') {
    console.log(`--> OPTIONS ${ctx.path}: Setting 204 y terminando.`);
    ctx.status = 204; // No Content - Standard response for successful preflight
    // CORS headers are automatically handled by the @koa/cors middleware earlier
    // Do NOT call await next() here, stop processing.
  } else {
    console.log(`--> ${ctx.method} ${ctx.path}: No es OPTIONS, llamando a next().`);
    await next(); // Proceed for non-OPTIONS requests
  }
});

// --- LOGGING MIDDLEWARE (Antes de Error Handler) ---
app.use(async (ctx, next) => { console.log(`--> ${ctx.method} ${ctx.path} (Antes del handler de errores)`); await next(); });

// --- GLOBAL ERROR HANDLING MIDDLEWARE (Including 401 from JWT) ---
// Catches errors thrown by later middleware (like requireAuth or route handlers)
app.use(async (ctx, next) => {
  try {
    console.log(`--> ${ctx.method} ${ctx.path} (Dentro del try del handler de errores, llamando a next())`);
    await next(); // Execute subsequent middleware (including router and potentially requireAuth)
    console.log(`--> ${ctx.method} ${ctx.path} (Después de next() en handler de errores - Status final: ${ctx.status})`);

    // Handle 404 Not Found explicitly if not handled by router
    if (ctx.status === 404 && !ctx.body) {
        console.log(`--> ${ctx.method} ${ctx.path} (Ruta no encontrada, devolviendo 404 JSON)`);
        ctx.body = { error: 'Not Found', message: `No route found for ${ctx.method} ${ctx.path}` };
    }

  } catch (err) {
    console.error(`--> ${ctx.method} ${ctx.path} (Error capturado en handler global)`, { status: err.status, message: err.message, stack: err.stack }); // Log more details

    if (err.status === 401) {
      // Specifically handle JWT authentication errors
      console.log(`--> ${ctx.method} ${ctx.path} (Devolviendo error 401 JSON porque err.status es 401)`);
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized', message: err.originalError ? err.originalError.message : err.message }; // Use originalError if available from koa-jwt
      // Do not rethrow, we've handled it.
    } else {
      // Handle other errors (e.g., validation errors, database errors, internal logic errors)
      console.error(`--> ${ctx.method} ${ctx.path} (Error NO 401 capturado (${err.status || 'sin status'}), devolviendo 500 JSON)`);
      ctx.status = err.status || 500;
      ctx.body = {
          error: err.name || 'Internal Server Error',
          message: err.message || 'An unexpected error occurred.',
          // Optionally include stack in development:
          // stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        };
       // Optionally emit an 'error' event for Koa's default handler, but setting body is usually sufficient
       // ctx.app.emit('error', err, ctx);
    }
  }
});


// --- HELPERS (Definitions) ---
const validatePropertyPayload = payload => { /* ... (keep your existing validation logic) ... */
    const errors = [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { isValid: false, errors: ['Request body must be a JSON object'] };
    }
    const sanitized = { ...payload };
    // URL Validation
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
    // Timestamp Validation
    if (typeof payload.timestamp !== 'string' || payload.timestamp.trim() === '') {
        errors.push('`timestamp` must be provided as a string');
    } else {
        const parsedTimestamp = Date.parse(payload.timestamp);
        if (Number.isNaN(parsedTimestamp)) {
            errors.push('`timestamp` must be a valid ISO 8601 date/time string');
        } else {
            // Store consistent ISO string
            sanitized.timestamp = new Date(parsedTimestamp).toISOString();
        }
    }
    // Optional fields validation (Location)
    if (payload.location !== undefined && payload.location !== null) {
        if (typeof payload.location !== 'string' || payload.location.trim() === '') {
            errors.push('`location` must be a non-empty string when provided');
        } else {
            sanitized.location = payload.location.trim();
        }
    } else {
      sanitized.location = null; // Ensure null if not provided or empty
    }
    // Optional fields validation (Price)
     if (payload.price !== undefined && payload.price !== null && payload.price !== '') {
        let priceValue = payload.price;
        if (typeof priceValue === 'string') priceValue = priceValue.trim().replace(/[$.]/g, ''); // Clean price string
        const parsedPrice = Number(priceValue);
        if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
            errors.push('`price` must be a non-negative number when provided');
        } else {
            sanitized.price = parsedPrice;
        }
    } else {
        sanitized.price = null; // Ensure null if not provided or empty
    }
    // Optional fields validation (Currency)
    if (payload.currency !== undefined && payload.currency !== null) {
       if (typeof payload.currency !== 'string' || payload.currency.trim() === '') {
           errors.push('`currency` must be a non-empty string when provided (e.g., CLP, UF)');
       } else {
           sanitized.currency = payload.currency.trim().toUpperCase();
            if (!['CLP', 'UF', '$'].includes(sanitized.currency)) { // Allow '$' as alias for CLP maybe? Adjust as needed.
               // errors.push('`currency` must be either CLP or UF'); // Be stricter if needed
           }
            if (sanitized.currency === '$') sanitized.currency = 'CLP'; // Normalize $
       }
   } else if (sanitized.price !== null) {
        // If price is given, assume CLP if currency is missing? Or make currency required if price exists?
        sanitized.currency = 'CLP'; // Default assumption if price exists but currency doesn't
        console.warn(`⚠️ Currency not provided for price ${sanitized.price}, assuming CLP.`);
   } else {
     sanitized.currency = null;
   }
    return { isValid: errors.length === 0, errors, value: sanitized };
 };

const RESERVATION_RATE = 0.1;

const normalizeCurrency = currency =>
  typeof currency === 'string' ? currency.trim().toUpperCase() : null;

const computeReservationCost = async propertyData => {
    if (!propertyData || typeof propertyData.price !== 'number' || !Number.isFinite(propertyData.price) || propertyData.price < 0) {
        console.warn("computeReservationCost: Invalid or missing numeric price.", propertyData);
        return null;
    }
    const price = propertyData.price;
    const currency = normalizeCurrency(propertyData.currency) || 'CLP';
    const timestamp = propertyData.timestamp || new Date().toISOString();
    try {
        if (currency === 'UF') {
            const ufValue = await getUfValue(timestamp);
            if (typeof ufValue !== 'number' || !Number.isFinite(ufValue) || ufValue <= 0) {
                 console.error(`computeReservationCost: Failed to get valid UF value for timestamp ${timestamp}. Got: ${ufValue}`);
                throw new Error('UF value is invalid or could not be retrieved');
            }
            return Math.round(price * ufValue * RESERVATION_RATE);
        } else if (currency === 'CLP') {
            return Math.round(price * RESERVATION_RATE);
        } else {
            console.warn(`computeReservationCost: Unsupported currency "${currency}" provided.`);
            return null;
        }
    } catch (error) {
         console.error(`computeReservationCost: Error calculating cost for price=${price} ${currency} at ${timestamp}:`, error);
         return null;
    }
};

function resolveHeartbeatUrl() { /* ... (keep original) ... */ }
const HEARTBEAT_TIMEOUT_MS = 2500;

// --- ROUTER Definition ---
const router = new Router();

// --- PUBLIC ROUTES (No requireAuth) ---
router.get('/workers/heartbeat', async (ctx) => {
    const t0 = Date.now();
    try {
        // Ping job_master health endpoint (assuming it needs auth)
        const res = await _fetch(`${JOB_MASTER_URL}/health`, { // Make sure this endpoint exists on job_master
            headers: { Authorization: `Bearer ${JOB_MASTER_TOKEN}` }
        });
        const ok = res.ok;
        const t1 = Date.now();
        // Try to get latency from response if job_master calculates it, otherwise estimate
        let latency = t1 - t0;
        try {
            const json = await res.json();
            if (json && typeof json.latency_ms === 'number') {
                latency = json.latency_ms;
            }
        } catch {/* Ignore JSON parse error */}

        ctx.body = { ok, latency_ms: latency };
    } catch (err) {
        const t1 = Date.now();
        console.error("Error during heartbeat check:", err.message);
        ctx.status = 200; // Respond 200 so frontend can display status
        ctx.body = { ok: false, latency_ms: t1 - t0, error: `Failed to reach job master: ${err.message}` };
    }
});

// --- PROTECTED ROUTES (Use requireAuth) ---
router.post('/recommendations/queue', requireAuth, async (ctx) => {
    try {
        const user = await getOrCreateUserFromToken(ctx.state.user || {});
        const { top_n = 8, filter = {} } = ctx.request.body || {};

        console.log(`Queuing recommendation job for user ${user.id}`);
        const resp = await _fetch(`${JOB_MASTER_URL}/jobs`, { // Assuming job_master handles job creation at /jobs
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${JOB_MASTER_TOKEN}`
            },
            body: JSON.stringify({ user_id: user.id, top_n, filter, job_type: 'recommendation' })
        });

        if (!resp.ok) {
            const text = await resp.text();
            console.error(`Job master failed (${resp.status}): ${text}`);
            ctx.status = resp.status; // Propagate status code
            ctx.body = { error: 'Job master failed', details: text };
            return;
        }

        const json = await resp.json();
        ctx.status = 202; // Accepted for processing
        ctx.body = json;
    } catch (err) {
        console.error('Internal error queuing recommendation job:', err);
        ctx.status = 500;
        ctx.body = { error: 'Internal error queuing job', details: err.message };
    }
});

router.get('/recommendations/status/:job_id', requireAuth, async (ctx) => {
    const { job_id } = ctx.params;
    try {
        const user = await getOrCreateUserFromToken(ctx.state.user || {});
        console.log(`Checking job status for ${job_id} (user ${user.id})`);
        const resp = await _fetch(`${JOB_MASTER_URL}/jobs/${encodeURIComponent(job_id)}`, {
            headers: { Authorization: `Bearer ${JOB_MASTER_TOKEN}` }
        });

        if (resp.status === 404) {
            ctx.status = 404;
            ctx.body = { error: 'Job not found' };
            return;
        }
        if (!resp.ok) {
            const text = await resp.text();
             console.error(`Job master failed checking status (${resp.status}): ${text}`);
            ctx.status = resp.status;
            ctx.body = { error: 'Job master failed', details: text };
            return;
        }

        const data = await resp.json();
        // Security check: Ensure the user requesting status owns the job
        if (data?.job?.user_id && data.job.user_id !== user.id) {
             console.warn(`Forbidden attempt: User ${user.id} tried to access job ${job_id} owned by ${data.job.user_id}`);
            ctx.status = 403;
            ctx.body = { error: 'Forbidden: You do not own this job' };
            return;
        }

        ctx.body = data;
    } catch (err) {
        console.error(`Internal error checking job status for ${job_id}:`, err);
        ctx.status = 500;
        ctx.body = { error: 'Internal error checking job status', details: err.message };
    }
});

router.get('/me', requireAuth, async ctx => {
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
        console.error('Error in /me route:', err);
        // Use 500 if the error likely originates from the server/DB side during findOrCreate
        ctx.status = err.message.includes('sub claim') ? 400 : 500;
        ctx.body = { error: 'Could not retrieve user profile', message: err.message };
    }
});

router.post('/properties', requireAuth, async ctx => {
    try {
        const { isValid, errors, value: propertyData } = validatePropertyPayload(ctx.request.body);
        if (!isValid) {
            console.warn(`Invalid property payload received: ${errors.join(', ')}`, ctx.request.body);
            ctx.status = 400;
            ctx.body = { error: 'Invalid property payload', details: errors };
            return;
        }

        let reservationCost = await computeReservationCost(propertyData);
        if (reservationCost === null) {
             console.warn(`⚠️ Could not compute reservation cost for ${propertyData.url}, proceeding without it.`);
        }

        const existingProperty = await Property.findOne({
            where: sequelize.where(sequelize.json('data.url'), propertyData.url),
        });

        if (existingProperty) {
            const updates = {
                visits: sequelize.literal('visits + 1'),
                updated_at: propertyData.timestamp // Reflects last seen time
            };
            if (reservationCost !== null) {
                updates.reservation_cost = reservationCost;
            }
            await existingProperty.update(updates);
            console.log(`📈 Visit incremented for property: ${propertyData.url}`);
            ctx.body = await Property.findByPk(existingProperty.id); // Return the updated record
            ctx.status = 200; // OK
        } else {
            const newProperty = await Property.create({
                data: propertyData,
                visits: 1,
                updated_at: propertyData.timestamp,
                reservation_cost: reservationCost
            });
            console.log(`✨ New property created: ${propertyData.url} with ID ${newProperty.id}`);
            ctx.body = newProperty;
            ctx.status = 201; // Created
        }
    } catch (err) {
        console.error('Error inserting/updating property:', err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error processing property' };
    }
});

router.get('/properties', requireAuth, async ctx => {
    try {
        const { page = 1, limit = 25, price, location, date, currency } = ctx.query;
        // Validate and parse pagination parameters
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
            ctx.status = 400;
            ctx.body = { error: "Invalid pagination parameters: 'page' and 'limit' must be positive integers." };
            return;
        }
        const offset = (pageNum - 1) * limitNum;

        const whereClauses = {};
        const andConditions = []; // Build conditions in an array

        // Price filter
        if (price) {
            const priceValue = parseFloat(price);
            if (!isNaN(priceValue)) {
                andConditions.push(
                    sequelize.where(
                        sequelize.cast(sequelize.json('data.price'), 'numeric'),
                        { [Op.lte]: priceValue } // Use lte (less than or equal to)
                    )
                );
                // Currency filter only applies if price filter is active
                 andConditions.push(
                     sequelize.where(
                         sequelize.json('data.currency'),
                         (currency && currency.toUpperCase() === 'UF') ? 'UF' : 'CLP'
                     )
                 );
            } else {
                 console.warn(`Invalid price filter value received: ${price}`);
            }
        }

        // Location filter
        if (location) {
            const searchTerm = String(location).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            if (searchTerm) {
                andConditions.push(
                    sequelize.where(
                        sequelize.fn('unaccent', sequelize.fn('lower', sequelize.json('data.location'))),
                        { [Op.like]: `%${searchTerm}%` }
                    )
                );
            }
        }

        // Date filter
        if (date) {
            // Basic validation for YYYY-MM-DD format
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                andConditions.push(
                    sequelize.where(
                        sequelize.fn('DATE', sequelize.cast(sequelize.json('data.timestamp'), 'timestamp with time zone')),
                        date
                    )
                );
            } else {
                 console.warn(`Invalid date filter value received (expected YYYY-MM-DD): ${date}`);
            }
        }

        if (andConditions.length > 0) {
            whereClauses[Op.and] = andConditions;
        }

        const { count, rows: properties } = await Property.findAndCountAll({
            where: whereClauses,
            // Order by most recently *updated* in our DB (last seen), then maybe by original timestamp
            order: [
                ['updated_at', 'DESC'],
                [sequelize.cast(sequelize.json('data.timestamp'), 'timestamp with time zone'), 'DESC']
            ],
            limit: limitNum,
            offset: offset
        });

        ctx.body = {
            totalItems: count,
            totalPages: Math.ceil(count / limitNum),
            currentPage: pageNum,
            properties: properties, // The array of properties for the current page
        };
    } catch (err) {
        console.error('Error fetching properties:', err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error fetching properties' };
    }
});

router.get('/properties/:id', requireAuth, async ctx => {
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
        console.error(`Error fetching property ${propertyId}:`, err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error fetching property details' };
    }
});

router.post('/properties/buy', requireAuth, async ctx => {
    const { url } = ctx.request.body;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        ctx.status = 400;
        ctx.body = { error: "Valid 'url' is required in the request body" };
        return;
    }
    const cleanUrl = url.trim();

    let user;
    let reservation_cost;
    let property;
    let requestId = uuidv4(); // Generate UUID upfront for logging
    let buyOrder = `G9-${requestId.substring(0, 23)}`; // Generate buyOrder upfront

    const transaction = await sequelize.transaction(); // Use DB transaction

    try {
        console.log(`🔄 [${requestId}] Processing buy request for URL: ${cleanUrl}`);

        try {
            user = await getOrCreateUserFromToken(ctx.state.user || {});
        } catch (err) {
            console.error(`❌ [${requestId}] Invalid token payload:`, err.message);
            ctx.status = 400; // Use 400 for bad token claims
            ctx.body = { error: 'Invalid token payload', message: err.message };
            await transaction.rollback(); // Rollback DB transaction
            return;
        }
         console.log(` -> User ID: ${user.id}`);

        // 1. Find property (lock row within transaction)
        property = await Property.findOne({
            where: sequelize.where(sequelize.json('data.url'), cleanUrl),
            lock: transaction.LOCK.UPDATE, // Lock the property row
            transaction
        });
        if (!property) {
            console.warn(`❌ [${requestId}] Property not found for URL: ${cleanUrl}`);
            ctx.status = 404;
            ctx.body = { error: "Property not found for the given URL" };
            await transaction.rollback();
            return;
        }
         console.log(` -> Property ID: ${property.id}, Visits: ${property.visits}`);


        // Check if property has visits available
        if (property.visits <= 0) {
             console.warn(`❌ [${requestId}] No visits available for property ${property.id} (URL: ${cleanUrl})`);
             ctx.status = 409; // Conflict - resource state prevents action
             ctx.body = { error: "No visits available for this property. It might have been reserved already." };
             await transaction.rollback();
             return;
        }


        // 2. Calculate reservation cost
        if (!property.data) {
           throw new Error(`Property ${property.id} found but has no data field`);
        }
        reservation_cost = await computeReservationCost(property.data);
        if (reservation_cost === null || reservation_cost <= 0) {
            console.error(`❌ [${requestId}] Invalid reservation cost calculated for ${cleanUrl}: ${reservation_cost}`);
            throw new Error('Could not compute a valid reservation cost (must be > 0)');
        }
         console.log(` -> Reservation Cost: ${reservation_cost} CLP`);

        // 3. Webpay Return URL Check
        if (!WEBPAY_RETURN_URL) {
            console.error("❌ FATAL: WEBPAY_RETURN_URL environment variable is not set!");
            throw new Error("Server configuration error: Webpay return URL missing.");
        }
        // IMPORTANTÍSIMO: enviar EXACTAMENTE WEBPAY_RETURN_URL a Transbank (sin concatenar paths)
        // Debe ser una URL ABSOLUTA que apunte a /payments/webpay/return (POST)
        // Validación básica:
        try { new URL(WEBPAY_RETURN_URL); } catch { throw new Error('WEBPAY_RETURN_URL must be an absolute URL'); }

        // 4. Create Webpay transaction
        console.log(`⏳ [${requestId}] Creating Webpay transaction with buyOrder=${buyOrder}, amount=${reservation_cost}, returnUrl=${WEBPAY_RETURN_URL}`);
        const tx = await createTransaction(buyOrder, `user-${user.id}`, reservation_cost, WEBPAY_RETURN_URL);
        console.log(`💳 [${requestId}] Webpay transaction created: token=${tx.token}`);

        // 5. Create Purchase Request in DB (within transaction)
        await Request.create({
           request_id: requestId,
           buy_order: buyOrder,
           user_id: user.id,
           property_url: cleanUrl,
           amount_clp: reservation_cost,
           status: 'PENDING',
           deposit_token: tx.token,
           retry_used: false
        }, { transaction });
        console.log(`💾 [${requestId}] Purchase request saved locally with status PENDING.`);

        // 6. Decrement visits (within transaction)
        await property.decrement('visits', { transaction });
        console.log(`🔽 [${requestId}] Visit decremented for property: ${cleanUrl}`);

        // If all DB operations succeed, commit the transaction
        await transaction.commit();
        console.log(`✅ [${requestId}] DB Transaction committed.`);

        // 7. (Optional but good) Send to MQTT *after* DB commit is successful
        try {
             const mqttPayload = await sendPurchaseRequest(cleanUrl, reservation_cost, user.id, tx.token, requestId, buyOrder);
             console.log(`📤 [${requestId}] Buy request sent via MQTT. Payload:`, mqttPayload);
        } catch (mqttError) {
             // Log MQTT error but don't fail the whole request since DB is committed and payment initiated
             console.error(`⚠️ [${requestId}] Failed to send purchase request via MQTT after DB commit:`, mqttError);
             // Maybe enqueue for later retry?
        }


        // 8. Respond to frontend with Webpay details
        ctx.body = {
            message: "Solicitud iniciada, redirigiendo a Webpay...",
            webpay_url: tx.url,
            webpay_token: tx.token,
            request_id: requestId,
            buy_order: buyOrder
        };
        ctx.status = 200;

    } catch (err) {
        // Rollback transaction if it's still active
        if (transaction && !transaction.finished) {
            console.warn(`[${requestId}] Rolling back DB transaction due to error.`);
            await transaction.rollback();
        }

        console.error(`❌ Critical Error in /properties/buy for request ${requestId}:`, {
            message: err.message,
            stack: err.stack,
            url: cleanUrl,
            userId: user ? user.id : 'N/A',
            calculated_cost: reservation_cost,
        });

        // No need to restore visit count here, as rollback undid the decrement

        ctx.status = err.status || 500; // Use error status if available (e.g., from computeCost)
        ctx.body = {
            error: "Error processing purchase request",
            details: err.message,
            request_id: requestId // Include generated ID for tracing
        };
    }
});


router.get('/reservations', requireAuth, async ctx => {
    let user;
    try {
        user = await getOrCreateUserFromToken(ctx.state.user || {});
    } catch (err) {
        ctx.status = 400; // Or 500 if internal error during findOrCreate
        ctx.body = { error: 'Invalid token payload or failed to retrieve user', message: err.message };
        return;
    }

    try {
        const reservations = await Request.findAll({
            where: { user_id: user.id },
            order: [['created_at', 'DESC']], // Show most recent first
        });
        ctx.body = reservations.map(r => r.toJSON()); // Return clean data
    } catch (err) {
        console.error(`Error fetching reservations for user ${user.id}:`, err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error fetching reservations' };
    }
});


router.post('/reservations/:request_id/retry', requireAuth, async ctx => {
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
        ctx.body = { error: 'Invalid token payload or failed to retrieve user', message: err.message };
        return;
    }

    const transaction = await sequelize.transaction();
    try {
        const request = await Request.findOne({
            where: { request_id },
            lock: transaction.LOCK.UPDATE,
            transaction
        });

        if (!request) {
            ctx.status = 404;
            ctx.body = { error: 'Request not found' };
            await transaction.rollback();
            return;
        }
        if (request.user_id !== user.id) {
            ctx.status = 403;
            ctx.body = { error: 'Forbidden: You do not own this request' };
            await transaction.rollback();
            return;
        }
        const status = String(request.status || '').toUpperCase();
        if (!['ERROR', 'REJECTED'].includes(status)) {
            ctx.status = 400;
            ctx.body = { error: `Only failed requests (ERROR, REJECTED) can be retried. Current status: ${status}` };
            await transaction.rollback();
            return;
        }
        if (request.retry_used) {
            ctx.status = 409; // Conflict
            ctx.body = { error: 'Retry already used for this request' };
            await transaction.rollback();
            return;
        }

        // --- Logic to republish ---
        console.log(`🔄 Retrying request ${request_id}. Republishing to MQTT...`);
        // republishPurchaseRequest should ideally just take the necessary fields or the request object
        const mqttPayload = await republishPurchaseRequest(request); // Assuming this function handles the MQTT publish
        console.log(`📤 Republished payload for ${request_id}:`, mqttPayload);
        // --- End of republish logic ---

        // Update DB within transaction
        await request.update({
            retry_used: true,
            status: 'PENDING', // Reset status to Pending after retry initiated
            reason: 'Retry initiated via API',
            updated_at: new Date()
        }, { transaction });

        await transaction.commit();

        ctx.body = {
            message: 'Request retry initiated successfully',
            request: request.toJSON(),
        };
    } catch (err) {
        await transaction.rollback();
        console.error(`❌ Error retrying request ${request_id}:`, err);
        ctx.status = err.status || 500; // Use status from error if available
        ctx.body = { error: 'Internal server error during retry process', details: err.message };
    }
});


router.get('/reservations/:request_id', requireAuth, async ctx => {
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
        ctx.body = { error: 'Invalid token payload or failed to retrieve user', message: err.message };
        return;
    }

    try {
        const reservationRequest = await Request.findOne({
            where: { request_id, user_id: user.id }
        });

        if (!reservationRequest) {
            ctx.status = 404;
            ctx.body = { error: 'Reservation request not found or not owned by user' };
            return;
        }

        // Fetch associated property details (optional, could be done on frontend too)
        const property = await Property.findOne({
            where: sequelize.where(
                sequelize.json('data.url'),
                reservationRequest.property_url
            ),
        });

        ctx.body = {
            // Include all relevant fields from reservationRequest
            status: reservationRequest.status,
            reason: reservationRequest.reason,
            retry_used: reservationRequest.retry_used,
            reservation_details: reservationRequest.toJSON(), // Full request object
            property_details: property ? property.toJSON() : null, // Include if found
        };
        ctx.status = 200;
    } catch (err) {
        console.error(`❌ Error fetching details for reservation request ${request_id}:`, err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error fetching reservation details' };
    }
});

// POST /payments/webpay/return - Webpay vuelve con form POST (token_ws)
router.post(
  '/payments/webpay/return',
  // body urlencoded porque Webpay vuelve con form POST
  koaBody({ urlencoded: true, json: false, multipart: false }),
  async (ctx) => {
    try {
      const token = ctx.request.body?.token_ws;
      if (!token) {
        ctx.status = 400;
        ctx.body = 'Missing token_ws';
        return;
      }

      // 1) confirmar/commit transacción con Webpay (SDK)
      const result = await commitTransaction(token);
      const mapped = mapWebpayStatus(result);

      // 2) guardar estado en DB (y restaurar visitas si corresponde)
      const t = await sequelize.transaction();
      let requestRow = null;
      try {
        requestRow = await Request.findOne({
          where: { deposit_token: token },
          lock: t.LOCK.UPDATE,
          transaction: t
        });

        if (requestRow) {
          const reason = (result && result.response_code === 0)
            ? 'Webpay payment approved'
            : `Webpay payment failed/rejected (Code: ${result?.response_code}, Status: ${result?.status})`;

          await requestRow.update({
            status: mapped,
            reason,
            updated_at: new Date()
          }, { transaction: t });

          if (mapped === 'REJECTED' || mapped === 'ERROR') {
            const prop = await Property.findOne({
              where: sequelize.where(sequelize.json('data.url'), requestRow.property_url),
              lock: t.LOCK.UPDATE,
              transaction: t
            });
            if (prop) await prop.increment('visits', { transaction: t });
          }
        } else {
          console.error(`POST /payments/webpay/return: No request found for token ${token}`);
        }

        await t.commit();

        // 3) redirigir al frontend al detalle de la reserva
        const requestId = requestRow ? requestRow.request_id : 'unknown';
        const statusParam = (mapped === 'ACCEPTED') ? 'ok' : 'failed';
        return ctx.redirect(302, `${FRONT}/reservations/${requestId}?status=${statusParam}`);
      } catch (e) {
        try { await t.rollback(); } catch {}
        throw e;
      }
    } catch (e) {
      console.error('❌ Error en POST /payments/webpay/return:', e);
      return ctx.redirect(302, `${FRONT}/reservations?status=failed`);
    }
  }
);

// GET /payments/webpay/return - User redirection endpoint after cancel/timeout (TBK params) o fallback con token_ws
router.get('/payments/webpay/return', async ctx => {
    const { token_ws, TBK_TOKEN, TBK_ORDEN_COMPRA } = ctx.query;

    let redirectUrlBase = `${FRONT}/reservations`;
    try {
        if (token_ws) {
            // Caso poco común: GET con token_ws; usar estado que tengamos
            const reqRow = await Request.findOne({ where: { deposit_token: token_ws } });
            const reqId = reqRow ? reqRow.request_id : 'unknown';
            const status = reqRow ? (reqRow.status || 'PENDING') : 'ERROR';
            const statusParam = (status === 'ACCEPTED') ? 'ok' : (status === 'PENDING' ? 'processing' : 'failed');
            ctx.redirect(`${redirectUrlBase}/${reqId}?status=${statusParam}`);
            return;
        }

        if (TBK_TOKEN && TBK_ORDEN_COMPRA) {
            // Usuario canceló
            const t = await sequelize.transaction();
            try {
                const request = await Request.findOne({
                    where: { buy_order: TBK_ORDEN_COMPRA },
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });

                if (request && request.status === 'PENDING') {
                    await request.update({
                        status: "REJECTED",
                        reason: "User cancelled payment at Webpay",
                        updated_at: new Date()
                    }, { transaction: t });

                    // Restore visit count
                    const property = await Property.findOne({
                        where: sequelize.where(sequelize.json('data.url'), request.property_url),
                        lock: t.LOCK.UPDATE,
                        transaction: t
                    });
                    if (property) {
                        await property.increment('visits', { transaction: t });
                    }
                    await t.commit();
                    ctx.redirect(`${redirectUrlBase}/${request.request_id}?status=failed&reason=UserCancelled`);
                    return;
                }

                await t.commit();
                if (request) {
                    ctx.redirect(`${redirectUrlBase}/${request.request_id}?status=${request.status || 'failed'}&reason=AlreadyFinalized`);
                } else {
                    ctx.redirect(`${redirectUrlBase}?status=failed&reason=RequestNotFoundForOrder`);
                }
            } catch (err) {
                try { await t.rollback(); } catch {}
                throw err;
            }
            return;
        }

        if (TBK_ORDEN_COMPRA) {
            // Timeout/fallo sin TBK_TOKEN
            const request = await Request.findOne({ where: { buy_order: TBK_ORDEN_COMPRA } });
            if (request) {
                const status = request.status || 'failed';
                const reqId = request.request_id;
                const statusParam = (status === 'ACCEPTED') ? 'ok' : (status === 'PENDING' ? 'processing' : 'failed');
                ctx.redirect(`${redirectUrlBase}/${reqId}?status=${statusParam}`);
            } else {
                ctx.redirect(`${redirectUrlBase}?status=failed&reason=RequestNotFoundForOrder`);
            }
            return;
        }

        // Sin parámetros conocidos
        ctx.status = 400;
        ctx.body = { error: "Missing Webpay parameters in query string" };
    } catch (err) {
        console.error("❌ Critical Error in GET /payments/webpay/return:", err);
        ctx.redirect(`${redirectUrlBase}?status=failed&reason=ServerError`);
    }
});


// --- LOG ANTES DEL ROUTER ---
// Este log debe ir ANTES de app.use(router.routes())
app.use(async (ctx, next) => { console.log(`--> ${ctx.method} ${ctx.path} (Antes de usar el Router)`); await next(); });

// Montar el router DESPUÉS de todos los middlewares globales
app.use(router.routes()).use(router.allowedMethods());

// --- LOG FINAL (Si no fue manejado por el router) ---
app.use(async (ctx, next) => {
    // This middleware only runs if no route was matched
    console.log(`--> ${ctx.method} ${ctx.path} (Fin cadena middleware - RUTA NO ENCONTRADA - Status: ${ctx.status})`);
    // Explicitly set 404 if not already set by allowedMethods or previous middleware
    if (!ctx.status || ctx.status === 404) {
         ctx.status = 404;
         ctx.body = { error: 'Not Found', message: `The requested path ${ctx.path} was not found on this server.` };
    }
    // No need to call next() here
});


// --- LISTEN ---
const PORT = process.env.APP_PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor web corriendo en puerto ${PORT}`);
});

// Optional: Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    // Close DB connections, etc.
    // server.close(() => { // Assuming server instance is stored
    //     console.log('HTTP server closed');
    //     process.exit(0);
    // });
    process.exit(0); // Simple exit for now
});
process.on('SIGINT', () => {
     console.log('SIGINT signal received: closing HTTP server');
     process.exit(0);
});
