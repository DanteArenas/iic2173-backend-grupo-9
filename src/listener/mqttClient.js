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

// Función para calcular delay Fibonacci
const getFibonacciDelay = (attemptNumber, baseDelay = 1000, maxDelay = 30000) => {
    if (attemptNumber <= 0) return baseDelay;

    let a = 1, b = 1;
    for (let i = 2; i <= attemptNumber; i++) {
        const temp = a + b;
        a = b;
        b = temp;
    }

    const delay = Math.min(b * baseDelay, maxDelay);
    return delay;
};

// Cliente MQTT con retry y reconexión automática
class MqttClientWithRetry {
    constructor() {
        this.client = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.isConnecting = false;
        this.connect();
    }

    connect() {
        if (this.isConnecting) return;

        this.isConnecting = true;
        console.log(`Conectando al broker MQTT en ${url} (intento ${this.reconnectAttempts + 1})`);

        this.client = mqtt.connect(url, options);

        this.client.on('connect', () => {
            console.log('✅ Conectado al broker MQTT desde mqttClient');
            this.reconnectAttempts = 0;
            this.isConnecting = false;
        });

        this.client.on('error', (err) => {
            console.error('❌ Error de conexión MQTT:', err.message);
            this.handleReconnect();
        });

        this.client.on('close', () => {
            console.log('🔌 Conexión MQTT cerrada');
            this.handleReconnect();
        });

        this.client.on('offline', () => {
            console.log('📴 Cliente MQTT offline');
            this.handleReconnect();
        });
    }

    handleReconnect() {
        if (this.isConnecting) return;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`❌ Máximo número de intentos de reconexión alcanzado (${this.maxReconnectAttempts})`);
            return;
        }

        this.reconnectAttempts++;
        const delay = getFibonacciDelay(this.reconnectAttempts);

        console.log(`🔄 Reintentando conexión MQTT en ${delay}ms (intento ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.isConnecting = false;
            this.connect();
        }, delay);
    }

    // Método para suscribirse con retry
    subscribe(topic, callback) {
        if (!this.client || !this.client.connected) {
            console.log(`⏳ Esperando conexión para suscribirse a ${topic}`);
            setTimeout(() => this.subscribe(topic, callback), 1000);
            return;
        }

        this.client.subscribe(topic, (err) => {
            if (err) {
                console.error(`❌ Error al suscribirse a ${topic}:`, err);
                // Retry suscripción después de un delay
                setTimeout(() => this.subscribe(topic, callback), getFibonacciDelay(1));
            } else {
                console.log(`✅ Suscrito a ${topic}`);
                if (callback) callback();
            }
        });
    }

    // Delegar otros métodos al cliente MQTT
    on(event, handler) {
        if (this.client) {
            this.client.on(event, handler);
        } else {
            // Si el cliente no está listo, esperar y reintentar
            setTimeout(() => this.on(event, handler), 100);
        }
    }

    publish(topic, message, options, callback) {
        if (!this.client || !this.client.connected) {
            console.error('❌ No se puede publicar: cliente no conectado');
            return false;
        }
        return this.client.publish(topic, message, options, callback);
    }

    end() {
        if (this.client) {
            this.client.end();
        }
    }
}

const mqttClientWithRetry = new MqttClientWithRetry();

module.exports = mqttClientWithRetry;
