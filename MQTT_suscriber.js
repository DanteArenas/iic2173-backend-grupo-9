require('dotenv').config()

const mqtt = require('mqtt')

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

console.log('Options:');
console.log(options);

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

client.on('message', (topic, message) => {
    if (topic === 'properties/info') {
        try {
            const property = JSON.parse(message.toString());
            console.log('Propiedad recibida:', property);
        } catch (err) {
            console.error('Error parseando mensaje', err);
        }
    }
});