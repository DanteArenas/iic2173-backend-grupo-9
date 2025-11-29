// src/listener/sendPurchaseRequest.js
require('newrelic');
const client = require('./mqttClient');
const { withFibonacciRetry } = require('./retry');

async function sendPurchaseRequest(url, reservationCost, _userId, deposit_token, request_id, _buyOrder) {
    const timestamp = new Date().toISOString();

    try {
        console.log('🔄 Creating request in database...', { request_id, url, reservationCost });

        console.log('✅ Request created successfully');

        const payload = {
            request_id,
            deposit_token,
            group_id: process.env.GROUP_ID || "9",
            timestamp,
            url,
            origin: 0,
            operation: "BUY",
        };

        console.log('🔄 Publishing to MQTT with retry...', payload);
        await withFibonacciRetry(() => new Promise((resolvePublish, rejectPublish) => {
            client.publish("properties/requests-1", JSON.stringify(payload), (err) => {
                if (err) return rejectPublish(err);
                resolvePublish();
            });
        }), {
            onAttempt: ({ attempt, delay, error }) => {
                if (error) console.warn(`Reintentando publish properties/requests. Intento ${attempt}. Próximo intento en ${delay}ms. Motivo: ${error.message || error}`);
            },
        });
        console.log("📤 Solicitud publicada en MQTT:", payload);
        return payload;
    } catch (err) {
        console.error('❌ Error in sendPurchaseRequest:', err);
        throw err;
    }
}

module.exports = sendPurchaseRequest;
