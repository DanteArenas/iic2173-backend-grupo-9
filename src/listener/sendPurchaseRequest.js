// src/listener/sendPurchaseRequest.js
const { v4: uuidv4 } = require('uuid');
const Request = require('../models/Request');
const client = require('./mqttClient');

async function sendPurchaseRequest(url, reservationCost) {
    return new Promise(async (resolve, reject) => {
        const requestId = uuidv4();
        const timestamp = new Date().toISOString();

        try {
        await Request.create({
            request_id: requestId,
            property_url: url,
            amount_clp: reservationCost,
            status: "OK", 
        });

        const payload = {
            request_id: requestId,
            group_id: process.env.GROUP_ID || "9",
            timestamp,
            url,
            origin: 0,
            operation: "BUY",
        };

        client.publish("properties/requests", JSON.stringify(payload), (err) => {
            if (err) return reject(err);
            console.log("📤 Solicitud publicada en MQTT:", payload);
            resolve(payload);
        });
        } catch (err) {
        reject(err);
        }
    });
}

module.exports = sendPurchaseRequest;
