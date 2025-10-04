require('newrelic');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const axios = require('axios');


const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

const Request = require('../web_server/models/Request');
const Property = require('../web_server/models/Property');
const sequelize = require('../web_server/database');
const EventLog = require('../web_server/models/EventLog');
const client = require('./mqttClient');



// =========================
// Fetch de machine token
// =========================
const auth0IssuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
const auth0Audience = process.env.AUTH0_AUDIENCE;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;
const auth0ClientSecret = process.env.AUTH0_CLIENT_SECRET;

const issuerWithTrailingSlash = auth0IssuerBaseUrl && auth0IssuerBaseUrl.endsWith('/')
    ? auth0IssuerBaseUrl
    : auth0IssuerBaseUrl ? `${auth0IssuerBaseUrl}/` : null;

const auth0TokenUrl = process.env.AUTH0_TOKEN_URL
    || (issuerWithTrailingSlash ? `${issuerWithTrailingSlash}oauth/token` : null);

let cachedMachineToken = null;
let cachedMachineTokenExpiry = 0;

const fetchMachineToken = async () => {
    if (!auth0TokenUrl || !auth0Audience || !auth0ClientId || !auth0ClientSecret) {
        throw new Error('Auth0 machine-to-machine credentials are not configured');
    }

    const now = Date.now();
    if (cachedMachineToken && now < cachedMachineTokenExpiry) {
        return cachedMachineToken;
    }

    const tokenResponse = await axios.post(auth0TokenUrl, {
        grant_type: 'client_credentials',
        client_id: auth0ClientId,
        client_secret: auth0ClientSecret,
        audience: auth0Audience,
    }, {
        headers: { 'Content-Type': 'application/json' },
    });

    const { access_token: accessToken, expires_in: expiresIn } = tokenResponse.data;
    cachedMachineToken = accessToken;
    cachedMachineTokenExpiry = now + Math.max((expiresIn || 60) - 10, 10) * 1000;

    return cachedMachineToken;
};

// =========================
// Suscripciones
// =========================
client.subscribe('properties/info', (err) => {
    if (!err) console.log('✅ Suscrito a properties/info');
    else console.error('❌ Error al suscribirse:', err);
});

client.subscribe('properties/validation', (err) => {
    if (!err) console.log('✅ Suscrito a properties/validation');
    else console.error('❌ Error al suscribirse:', err);
});

client.subscribe('properties/requests', (err) => {
    if (!err) console.log('✅ Suscrito a properties/requests');
    else console.error('❌ Error al suscribirse:', err);
});

// =========================
// Handlers de mensajes
// =========================
client.on('message', async (topic, message) => {
    if (topic === 'properties/info') {
        let property;
        try {
            property = JSON.parse(message.toString());
            console.log('📩 Propiedad recibida:', property);

            const machineToken = await fetchMachineToken();
            await axios.post(`${process.env.API_URL}/properties`, property, {
                headers: { Authorization: `Bearer ${machineToken}` },
            });

            console.log('📤 Propiedad enviada a la API');
        } catch (err) {
            console.error('❌ Error procesando propiedad:', err);
        }

        if (property) {
            await EventLog.create({
                type: 'PROPERTY_INFO',
                payload: property,
                related_request_id: null,
            });
        }
    }

    if (topic === 'properties/validation') {
        let validation;
        let requestId;
        let status;
        try {
            validation = JSON.parse(message.toString());
            console.log('📩 Validación recibida:', validation);

            requestId = validation.request_id;
            status = validation.status;
            const { reason } = validation;

            const request = await Request.findOne({ where: { request_id: requestId } });
            if (request) {
                await request.update({
                    status: status.toUpperCase(),
                    reason: reason || null,
                    updated_at: new Date(),
                });
                console.log(`🔄 Request ${requestId} actualizado con estado ${status}`);
            } else {
                console.warn(`⚠️ Request ${requestId} no encontrado en DB`);
            }
        } catch (err) {
            console.error('❌ Error procesando validación:', err);
        }

        if (validation && status) {
            await EventLog.create({
                type: `VALIDATION_${status.toUpperCase()}`,
                payload: validation,
                related_request_id: requestId ?? null,
            });
        }
    }

    if (topic === 'properties/requests') {
        try {
            const requestMsg = JSON.parse(message.toString());
            console.log("📩 Request recibida:", requestMsg);

            const { request_id, group_id, url, operation } = requestMsg;


            if (String(group_id) === String(process.env.GROUP_ID)) {
                console.log(`Request ${request_id} es de mi grupo (${group_id}), ignorando.`);
                return;
            }


            console.log(` Request de otro grupo (${group_id}), registrando...`);

            await Request.create({
                request_id,
                property_url: url,
                amount_clp: 0, // monto?
                status: "OK",
                reason: `Request recibida de grupo ${group_id}`,
            });


            const property = await Property.findOne({
                where: sequelize.where(
                    sequelize.json('data.url'),
                    url
                ),
            });
            if (property && property.available_visits > 0) {
                await property.update({ available_visits: property.available_visits - 1 });
            }

            await EventLog.create({
                type: 'REQUEST_OTHER_GROUP',
                payload: requestMsg,
                related_request_id: request_id,
            });

        } catch (err) {
            console.error("Error procesando request:", err);
        }
    }
});
