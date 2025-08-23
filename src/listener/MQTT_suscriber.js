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

            const result = await dbClient.query(
                "SELECT id FROM properties WHERE data->>'url' = $1",
                [property.url]
            );

            if (result.rows.length > 0) {
                await dbClient.query(
                    `UPDATE properties 
                    SET visits = visits + 1, 
                        updated_at = $2
                    WHERE id = $1`,
                    [result.rows[0].id, property.timestamp]
                );
                console.log("♻️ Propiedad repetida, visitas incrementadas y fecha actualizada:", property.name);
            } else {
                await dbClient.query(
                    "INSERT INTO properties (data, updated_at) VALUES ($1, $2)",
                    [JSON.stringify(property), property.timestamp]
                );
                console.log("✅ Propiedad nueva guardada:", property.url);
            }

            console.log('✅ Propiedad guardada en PostgreSQL');
        } catch (err) {
            console.error('❌ Error procesando mensaje:', err);
        }
    }
});