require('dotenv').config({ path: '../../.env' });

const Koa = require('koa');
const { koaBody } = require('koa-body');
const { Pool } = require('pg');
const Router = require('@koa/router');

const app = new Koa();

app.use(koaBody());

app.pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: String(process.env.POSTGRES_PASSWORD),
});


const router = new Router();

// post /properties
router.post('/properties', async ctx => {
    try {
        const property = ctx.request.body;

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
            `SELECT * FROM properties ${whereSQL} ORDER BY (data->>'timestamp')::timestamp DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
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

app.listen(() => {
    console.log(`🚀 Servidor web corriendo`);
});