// src/listener/sendAuctionEvent.js
require('newrelic');
const client = require('./mqttClient');
const { withFibonacciRetry } = require('./retry');

async function sendAuctionEvent(eventPayload) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log("🔄 Enviando evento de subasta al broker...", eventPayload);

            await withFibonacciRetry(
                () =>
                    new Promise((resolvePublish, rejectPublish) => {
                        client.publish(
                            "properties/auctions",
                            JSON.stringify(eventPayload),
                            (err) => (err ? rejectPublish(err) : resolvePublish())
                        );
                    }),
                {
                    onAttempt: ({ attempt, delay, error }) => {
                        if (error)
                            console.warn(
                                `Reintentando publish a properties/auctions. ` +
                                `Intento ${attempt}. Próximo intento en ${delay}ms. Motivo: ${error.message || error}`
                            );
                    },
                }
            );

            console.log("📤 Evento de subasta enviado:", eventPayload);
            resolve(eventPayload);

        } catch (err) {
            console.error("❌ Error en sendAuctionEvent:", err);
            reject(err);
        }
    });
}

module.exports = sendAuctionEvent;
