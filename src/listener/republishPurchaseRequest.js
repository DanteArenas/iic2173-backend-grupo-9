// src/listener/republishPurchaseRequest.js
require('newrelic');
const Request = require('../models/Request');
const client = require('./mqttClient');
const { withFibonacciRetry } = require('./retry');

async function republishPurchaseRequest(requestId) {
    if (!requestId) {
        throw new Error('requestId is required');
    }

    const request = await Request.findOne({ where: { request_id: requestId } });
    if (!request) {
        const err = new Error('Request not found');
        err.code = 'NOT_FOUND';
        throw err;
    }

    const timestamp = new Date().toISOString();
    const payload = {
        request_id: request.request_id,
        group_id: process.env.GROUP_ID || '9',
        timestamp,
        url: request.property_url,
        origin: 0,
        operation: 'BUY',
    };

    await withFibonacciRetry(() => new Promise((resolvePublish, rejectPublish) => {
        client.publish('properties/requests-1', JSON.stringify(payload), (err) => {
            if (err) return rejectPublish(err);
            resolvePublish();
        });
    }));

    return payload;
}

module.exports = republishPurchaseRequest;
