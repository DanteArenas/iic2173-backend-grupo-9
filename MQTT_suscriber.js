require('dotenv').config()

const Koa = require('koa');
const Router = require('koa-router');
const mqtt = require('mqtt')

const app = new Koa();
const router = new Router();

// Lista en memoria de propiedades recibidas
let properties = [];

const client = mqtt.connect({
    host: process.env.HOST,
    port: process.env.PORT,
    username: process.env.USER,
    password: process.env.PASSWORD,
});

client.on('connect', () => {
    console.log('Conectado al broker');
    client.subscribe('properties/info', (err) => {
        if (!err) {
            console.log('Suscrito a properties/info');
        }
    });
});

client.on('message', (topic, message) => {
    if (topic === 'properties/info') {
        try {
            const property = JSON.parse(message.toString());
            console.log('Propiedad recibida:', property);
            properties.push(property);
        } catch (err) {
            console.error('Error parseando mensaje', err);
        }
    }
});

// Endpoint para ver las propiedades
router.get('/properties', (ctx) => {
    ctx.body = properties;
});

app.use(router.routes());
app.use(router.allowedMethods());

// Levantar servidor
const PORT = process.env.APP_PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});