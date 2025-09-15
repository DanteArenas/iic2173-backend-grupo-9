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
const { Pool } = require('pg');
const Router = require('@koa/router');

const app = new Koa();

app.use(koaBody());

const dbConfig = {
    host: process.env.POSTGRES_HOST || 'postgres',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'properties_db',
    user: process.env.POSTGRES_USER || 'properties_user',
    password: process.env.POSTGRES_PASSWORD || '',
};

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

app.pool = new Pool(dbConfig);


const router = new Router();

// post /properties
router.post('/properties', async ctx => {
    try {
        const { isValid, errors, value: property } = validatePropertyPayload(ctx.request.body);

        if (!isValid) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid property payload', details: errors };
            return;
        }

        console.log('Propiedad recibida:', property);

        // Buscar si ya existe por URL
        const result = await ctx.app.pool.query(
            "SELECT id FROM properties WHERE data->>'url' = $1",
            [property.url]
        );

        if (result.rows.length > 0) {
            await ctx.app.pool.query(
                `UPDATE properties 
                 SET visits = visits + 1, 
                     updated_at = $2
                 WHERE id = $1`,
                [result.rows[0].id, property.timestamp]
            );
            console.log("♻️ Propiedad repetida, visitas incrementadas", { id: result.rows[0].id });
            ctx.status = 200;
        } else {
            const insert = await ctx.app.pool.query(
                "INSERT INTO properties (data, updated_at) VALUES ($1, $2) RETURNING id",
                [JSON.stringify(property), property.timestamp]
            );
            console.log("✅ Propiedad nueva guardada", { id: insert.rows[0].id });
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
router.get('/properties', async ctx => {
    try {
        const { page = 1, limit = 25, price, location, date, currency } = ctx.query;
        const offset = (page - 1) * limit;

        // Construir dinámicamente la cláusula WHERE y los parámetros
        let whereClauses = [];
        let queryParams = [];

        if (price) {
            queryParams.push(parseFloat(price));
            whereClauses.push(`(data->>'price')::numeric < $${queryParams.length}`);
            // Si no se recibe currency el default es CLP
            if (currency && currency.toLowerCase() == 'uf') {
                queryParams.push('UF');
            } else {
                queryParams.push("$");
            }
            whereClauses.push(`(data->>'currency') = $${queryParams.length}`);
        }



        if (location) {
            queryParams.push(`%${location.toLowerCase()}%`);
            whereClauses.push(`unaccent(lower(data->>'location')) LIKE unaccent($${queryParams.length})`);
        }

        if (date) {
            queryParams.push(date);
            whereClauses.push(`DATE((data->>'timestamp')::timestamp) = $${queryParams.length}`);
        }

        const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Consultar propiedades filtradas con paginación
        const result = await ctx.app.pool.query(
            `SELECT * FROM properties ${whereSQL} ORDER BY (data->>'timestamp')::timestamp ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
            [...queryParams, parseInt(limit), parseInt(offset)]
        );

        ctx.body = result.rows;

    } catch (err) {
        console.error('Error fetching properties:', err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error' };
    }
});

// RF2
// /properties/{:id}
router.get('/properties/:id', async ctx => {
    const { id } = ctx.params;

    try {
        const result = await ctx.app.pool.query(
            'SELECT * FROM properties WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            ctx.status = 404;
            ctx.body = { error: 'Property not found' };
            return;
        }

        ctx.body = result.rows[0];
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
