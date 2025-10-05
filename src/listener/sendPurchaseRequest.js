// src/listener/sendPurchaseRequest.js
require('newrelic');
const { v4: uuidv4 } = require('uuid');
const Request = require('../models/Request');
const client = require('./mqttClient');
const { withFibonacciRetry } = require('./retry');

async function sendPurchaseRequest(url, reservationCost, userId) {
    return new Promise(async (resolve, reject) => {
        const requestId = uuidv4();
        const timestamp = new Date().toISOString();

        try {
            console.log('🔄 Creating request in database...', { requestId, url, reservationCost });
            await Request.create({
                request_id: requestId,
                property_url: url,
                amount_clp: reservationCost,
                status: "OK",
                user_id: userId ?? null,
            });
            console.log('✅ Request created successfully');

            const payload = {
                request_id: requestId,
                group_id: process.env.GROUP_ID || "9",
                timestamp,
                url,
                origin: 0,
                operation: "BUY",
            };

            console.log('🔄 Publishing to MQTT with retry...', payload);
            await withFibonacciRetry(() => new Promise((resolvePublish, rejectPublish) => {
                client.publish("properties/requests", JSON.stringify(payload), (err) => {
                    if (err) return rejectPublish(err);
                    resolvePublish();
                });
            }), {
                onAttempt: ({ attempt, delay, error }) => {
                    if (error) console.warn(`Reintentando publish properties/requests. Intento ${attempt}. Próximo intento en ${delay}ms. Motivo:`, error.message || error);
                },
            });
            console.log("📤 Solicitud publicada en MQTT:", payload);
            resolve(payload);
        } catch (err) {
            console.error('❌ Error in sendPurchaseRequest:', err);
            reject(err);
        }
    });
}

module.exports = sendPurchaseRequest;
