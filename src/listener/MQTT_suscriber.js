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

// =========================
// Handlers de mensajes
// =========================
client.on('message', async (topic, message) => {
    if (topic === 'properties/info') {
        try {
        const property = JSON.parse(message.toString());
        console.log('📩 Propiedad recibida:', property);

        const machineToken = await fetchMachineToken();
        await axios.post(`${process.env.API_URL}/properties`, property, {
            headers: { Authorization: `Bearer ${machineToken}` },
        });

        console.log("📤 Propiedad enviada a la API");
        } catch (err) {
        console.error('❌ Error procesando propiedad:', err);
        }
    }

    if (topic === 'properties/validation') {
        try {
        const validation = JSON.parse(message.toString());
        console.log("📩 Validación recibida:", validation);

        const { request_id, status, reason } = validation;

        const request = await Request.findOne({ where: { request_id } });
        if (request) {
            await request.update({
            status: status.toUpperCase(),
            reason: reason || null,
            updated_at: new Date()
            });
            console.log(`🔄 Request ${request_id} actualizado con estado ${status}`);
        } else {
            console.warn(`⚠️ Request ${request_id} no encontrado en DB`);
        }
        } catch (err) {
        console.error('❌ Error procesando validación:', err);
        }
    }
});
