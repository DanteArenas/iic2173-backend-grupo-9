require('dotenv').config({ path: '../.env' });

const Koa = require('koa');
const { koaBody } = require('koa-body');
const { Pool } = require('pg');
const Router = require('@koa/router');

const app = new Koa();

app.use(koaBody());

app.pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    database: process.env.POSTGRES_NAME,
    user: process.env.POSTGRES_USER,
    password: String(process.env.POSTGRES_PASSWORD),
});


const router = new Router();

// get /properties
router.get('/properties', async ctx => {
    try {
        const { page = 1, limit = 25, price, location, date } = ctx.query;
        const offset = (page - 1) * limit;

        // Construir dinámicamente la cláusula WHERE y los parámetros
        let whereClauses = [];
        let queryParams = [];

        if (price) {
            queryParams.push(parseFloat(price));
            whereClauses.push(`(data->>'price')::numeric < $${queryParams.length}`);
        }

        if (location) {
            queryParams.push(`%${location.toLowerCase()}%`);
            whereClauses.push(`unaccent(lower(data->>'location')) LIKE unaccent($${queryParams.length})`);
        }

        if (date) {
            queryParams.push(date);
            whereClauses.push(`DATE(received_at) = $${queryParams.length}`);
        }

        const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Consultar propiedades filtradas con paginación
        const result = await ctx.app.pool.query(
            `SELECT * FROM properties ${whereSQL} ORDER BY received_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
            [...queryParams, parseInt(limit), parseInt(offset)]
        );

        ctx.body = result.rows;

    } catch (err) {
        console.error('Error fetching properties:', err);
        ctx.status = 500;
        ctx.body = { error: 'Internal server error' };
    }
});


app.use(router.routes()).use(router.allowedMethods());

app.listen(3000);