require('dotenv').config({ path: '../.env' });

const mqtt = require('mqtt')

const { Client } = require('pg')

// Configuración de PostgreSQL
const dbClient = new Client({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_NAME,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
});

// Conectar a PostgreSQL
dbClient.connect()
    .then(() => {
        console.log('✅ Conectado a PostgreSQL');
        // Crear tabla si no existe
        return dbClient.query(`
            CREATE TABLE IF NOT EXISTS properties (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    })
    .then(() => {
        console.log('📋 Tabla properties lista');
    })
    .catch(err => {
        console.error('❌ Error conectando a PostgreSQL:', err);
    });

const url = `mqtt://${process.env.HOST}:${process.env.PORT}`;

const options = {
    // Clean session
    clean: true,
    connectTimeout: 4000,
    // Authentication
    username: process.env.USER_mqtt,
    password: process.env.PASSWORD,
}

console.log('Conectando al broker MQTT en %s\n', url);

const client = mqtt.connect(url, options)

client.on('connect', () => {
    console.log('Conectado al broker');
    client.subscribe('properties/info', (err) => {
        if (!err) {
            console.log('Suscrito a properties/info');
        }
        else {
            console.error('Error al suscribirse:', err);
        }
    });
});

client.on('error', (err) => {
    console.error('❌ Error de conexión MQTT:', err);
    client.end();
});

client.on('message', async (topic, message) => {
    if (topic === 'properties/info') {
        try {
            const property = JSON.parse(message.toString());
            console.log('Propiedad recibida:', property);

            // Guardar en PostgreSQL
            await dbClient.query(
                'INSERT INTO properties (data) VALUES ($1)',
                [JSON.stringify(property)]
            );
            console.log('✅ Propiedad guardada en PostgreSQL');
        } catch (err) {
            console.error('❌ Error procesando mensaje:', err);
        }
    }
});