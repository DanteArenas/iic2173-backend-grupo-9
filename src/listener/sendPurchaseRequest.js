// src/listener/sendPurchaseRequest.js
require('newrelic');
const { v4: uuidv4 } = require('uuid');
const Request = require('../models/Request');
const client = require('./mqttClient');

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

// Función para retry con delay fibonacci
async function retryWithFibonacci(operation, maxAttempts = 5, context = 'operación') {
    let lastError;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            console.error(`❌ Error en ${context} (intento ${attempt + 1}/${maxAttempts}):`, error.message);

            if (attempt < maxAttempts - 1) {
                const delay = getFibonacciDelay(attempt + 1);
                console.log(`🔄 Reintentando ${context} en ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`${context} falló después de ${maxAttempts} intentos: ${lastError.message}`);
}

async function sendPurchaseRequest(url, reservationCost) {
    const requestId = uuidv4();
    const timestamp = new Date().toISOString();

    try {
        console.log('🔄 Creating request in database...', { requestId, url, reservationCost });

        // Retry para la creación en base de datos
        await retryWithFibonacci(async () => {
            return await Request.create({
                request_id: requestId,
                property_url: url,
                amount_clp: reservationCost,
                status: "OK",
            });
        }, 3, 'creación en base de datos');

        console.log('✅ Request created successfully');

        const payload = {
            request_id: requestId,
            group_id: process.env.GROUP_ID || "9",
            timestamp,
            url,
            origin: 0,
            operation: "BUY",
        };

        console.log('🔄 Publishing to MQTT...', payload);

        // Retry para la publicación MQTT
        const result = await retryWithFibonacci(() => {
            return new Promise((resolve, reject) => {
                client.publish("properties/requests", JSON.stringify(payload), (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        console.log("📤 Solicitud publicada en MQTT:", payload);
                        resolve(payload);
                    }
                });
            });
        }, 5, 'publicación MQTT');

        return result;

    } catch (err) {
        console.error('❌ Error in sendPurchaseRequest:', err);

        // Marcar el request como fallido en la base de datos usando ERROR
        try {
            await Request.update(
                {
                    status: "ERROR",
                    reason: `Technical error: ${err.message}`,
                    retry_count: 0,  // Inicializar contador de retry para uso posterior
                    can_retry: true  // Permitir retry manual
                },
                { where: { request_id: requestId } }
            );
        } catch (updateErr) {
            console.error('❌ Error updating failed request:', updateErr);
        }

        // Incluir el request_id en el error para que el endpoint lo pueda usar
        const error = new Error(err.message);
        error.request_id = requestId;
        throw error;
    }
}

module.exports = sendPurchaseRequest;
