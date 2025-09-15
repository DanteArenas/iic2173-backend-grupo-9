const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

const mqtt = require('mqtt')

const axios = require('axios');

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

// POST de la propiedad en la api
client.on('message', async (topic, message) => {
    if (topic === 'properties/info') {
        try {
            const property = JSON.parse(message.toString());
            console.log('Propiedad recibida:', property);

            // Mandar a la API
            await axios.post(`${process.env.API_URL}/properties`, property);

            console.log("📩 Propiedad enviada a la API");
        } catch (err) {
            console.error('❌ Error procesando mensaje:', err);
        }
    }
});
