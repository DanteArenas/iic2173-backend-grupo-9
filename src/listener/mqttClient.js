require('newrelic');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');


const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

const url = `mqtt://${process.env.HOST}:${process.env.PORT}`;

const options = {
    clean: true,
    connectTimeout: 4000,
    username: process.env.USER_mqtt,
    password: process.env.PASSWORD,
};

console.log('Conectando al broker MQTT en %s\n', url);

const client = mqtt.connect(url, options);

// Optional: helper to await connection readiness
let connected = false;
let connectResolve;
const connectedPromise = new Promise((resolve) => { connectResolve = resolve; });

client.on('connect', () => {
    connected = true;
    if (connectResolve) connectResolve();
    console.log('Conectado al broker desde mqttClient');
});

client.on('error', (err) => {
    console.error('❌ Error de conexión MQTT:', err);
    console.log(`Conexión MQTT fallida: ${process.env.HOST}:${process.env.PORT} `);
    // No llamar client.end(); dejamos que el cliente reintente según política interna de mqtt.js
});

module.exports = client;
module.exports.connectedPromise = connectedPromise;
