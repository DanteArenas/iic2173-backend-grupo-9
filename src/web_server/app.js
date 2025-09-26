const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

const Koa = require('koa');
const { koaBody } = require('koa-body');
const jwt = require('koa-jwt');
const jwksRsa = require('jwks-rsa');
const cors = require('@koa/cors');

const sequelize = require('./database');
const Property = require('./models/Property');
const User = require('./models/User');

const { Op } = require('sequelize');

sequelize.authenticate()
    .then(() => console.log('Conexión exitosa a la base de datos con Sequelize'))
    .catch(err => console.error('Error de conexión con Sequelize:', err));

const Router = require('@koa/router');

const app = new Koa();

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

const createAuthMiddleware = () => {
    const issuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
    const audience = process.env.AUTH0_AUDIENCE;

    if (!issuerBaseUrl || !audience) {
        console.warn('⚠️  Missing Auth0 configuration. Set AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE to protect routes.');
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
        } catch (err) {
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
        if (typeof priceValue === 'string') {
            priceValue = priceValue.trim();
        }

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


const router = new Router();

router.get('/me', requireAuth, async ctx => {
    const tokenPayload = ctx.state.user || {};
    const auth0UserId = tokenPayload.sub;

    if (!auth0UserId) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid token payload', message: 'sub claim is required' };
        return;
    }

    const emailClaim = typeof tokenPayload.email === 'string' ? tokenPayload.email.toLowerCase() : null;
    const nameClaim = typeof tokenPayload.name === 'string' && tokenPayload.name.trim() !== ''
        ? tokenPayload.name.trim()
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
    if (nameClaim && user.full_name !== nameClaim) {
        updates.full_name = nameClaim;
    }
    if (emailClaim && user.email !== emailClaim) {
        updates.email = emailClaim;
    }

    if (Object.keys(updates).length > 0) {
        await user.update(updates);
    }

    ctx.body = {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        auth0_user_id: user.auth0_user_id,
    };
});

// post /properties
router.post('/properties', requireAuth, async ctx => {
    try {
        const { isValid, errors, value: property } = validatePropertyPayload(ctx.request.body);

        if (!isValid) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid property payload', details: errors };
            return;
        }

        console.log('Propiedad recibida:', property);

        // Buscar si ya existe por URL
        const result = await Property.findOne({
            where: sequelize.where(
                sequelize.json('data.url'),
                property.url
            ),
            attributes: ['id']
        });

        if (result) {
            await Property.update(
                {
                    visits: sequelize.literal('COALESCE(visits, 0) + 1'),
                    updated_at: property.timestamp
                },
                { where: { id: result.id } }
            );
            console.log("♻️ Propiedad repetida, visitas incrementadas", { id: result.id });
            ctx.status = 200;
        } else {
            const nuevaPropiedad = await Property.create({
                data: property,
                updated_at: property.timestamp
            });
            console.log("✅ Propiedad nueva guardada", { id: nuevaPropiedad.id });
            ctx.status = 201;
        }
    } catch (err) {
        console.error('Error inserting property:', err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error' };
    }
});

// TODO: estandarizar las monedas de los precios

// RF1, 3 y 4
// get /properties
router.get('/properties', requireAuth, async ctx => {
    try {
        const { page = 1, limit = 25, price, location, date, currency } = ctx.query;
        const offset = (page - 1) * limit;

        // Construir el array de condiciones where para Sequelize
        const where = [];
        // Filtros sobre el campo data (JSONB)
        if (price) {
            where.push(
                sequelize.where(
                    sequelize.cast(sequelize.json('data.price'), 'numeric'),
                    { [Op.lt]: parseFloat(price) }
                )
            );
            // Si no se recibe currency el default es CLP
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
                    { [Op.like]: `%${location.toLowerCase()}%` }
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

// RF2
// /properties/{:id}
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


app.use(router.routes()).use(router.allowedMethods());

const PORT = process.env.APP_PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor web corriendo en puerto ${PORT}`);
});
