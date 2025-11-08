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
const { withFibonacciRetry } = require('./retry');



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
async function subscribeWithRetry(topic) {
    await withFibonacciRetry(() => new Promise((resolve, reject) => {
        client.subscribe(topic, (err) => {
            if (err) return reject(err);
            resolve();
        });
    }), {
        onAttempt: ({ attempt, delay, error }) => {
            if (error) console.warn(`Reintentando suscripción a ${topic}. Intento ${attempt}. Próximo intento en ${delay}ms. Motivo:`, error.message || error);
        },
    });
    console.log(`✅ Suscrito a ${topic}`);
}

async function subscribeAllTopics() {
    await Promise.all([
        subscribeWithRetry('properties/info'),
        subscribeWithRetry('properties/validation'),
        subscribeWithRetry('properties/requests-1'),
    ]);
}

client.on('connect', async () => {
    try {
        await subscribeAllTopics();
    } catch (err) {
        console.error('❌ Falló la resuscripción tras reconexión:', err);
    }
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
                    reason: Array.isArray(reason) 
                        ? reason.map(r => (r.message ? r.message : JSON.stringify(r))).join(", ") 
                        : (typeof reason === 'object' ? JSON.stringify(reason) : reason),
                    updated_at: new Date(),
                });
                console.log(`🔄 Request ${requestId} actualizado con estado ${status}`);

                // 👇 Ajustar visitas según resultado de la validación
                const property = await Property.findOne({
                    where: sequelize.where(
                        sequelize.json('data.url'),
                        request.property_url
                    ),
                });

                if (property) {
                    if (status.toUpperCase() === "REJECTED" || status.toUpperCase() === "ERROR") {
                        await property.update({ visits: property.visits + 1 });
                        console.log(`♻️ Visita devuelta para propiedad ${request.property_url}`);
                    } else if (status.toUpperCase() === "ACCEPTED") {
                        console.log(`✅ Visita confirmada para propiedad ${request.property_url}`);
                    }
                }
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


    // Dentro de client.on('message', ...)
    if (topic === 'properties/requests-1') {
        let requestMsg; // Definir fuera para usar en catch
        try {
            requestMsg = JSON.parse(message.toString());
            console.log("📩 Request recibida:", requestMsg);

            const { request_id, group_id, url, operation, amount_clp } = requestMsg; // Extraer amount_clp si viene

            // Validar que request_id existe
            if (!request_id) {
                console.error("❌ Mensaje en properties/requests sin request_id:", requestMsg);
                return; // Ignorar mensaje inválido
            }

            if (String(group_id) === String(process.env.GROUP_ID)) {
                console.log(`Request ${request_id} es de mi grupo (${group_id}), ignorando.`);
                return;
            }

            console.log(` Request de otro grupo (${group_id}), registrando...`);

            // 👇👇👇 REEMPLAZO CON findOrCreate 👇👇👇
            const [request, created] = await Request.findOrCreate({
                where: { request_id: request_id }, // Busca por el ID único
                defaults: { // Datos a usar SOLO si NO se encuentra y se debe crear
                    property_url: url,
                    // Usa el monto del mensaje si existe, sino 0 o null según tu lógica
                    amount_clp: typeof amount_clp === 'number' ? amount_clp : 0,
                    status: 'OK', // O 'PENDING'? Define qué estado tiene una request externa
                    reason: `Request recibida de grupo ${group_id}`,
                    buy_order: null,   // Explícitamente null
                    user_id: null,     // Explícitamente null (no es nuestro usuario)
                    deposit_token: null, // Explícitamente null
                    retry_used: false
                }
            });

            if (created) {
                console.log(`✅ Request ${request_id} de grupo ${group_id} registrada (NUEVA).`);

                // Solo decrementa visitas y loguea si es NUEVA
                const property = await Property.findOne({
                    where: sequelize.where(
                        sequelize.json('data.url'),
                        url
                    ),
                });
                if (property && property.visits > 0) {
                    // Usar decrement es más seguro contra condiciones de carrera
                    await property.decrement('visits');
                    console.log(`🔽 Visita decrementada para propiedad ${url} por request externa ${request_id}.`);
                } else if (property) {
                    console.warn(`⚠️ No se decrementó visita para ${url} (visits=${property.visits}) por request externa ${request_id}.`);
                }

                await EventLog.create({
                    type: 'REQUEST_OTHER_GROUP',
                    payload: requestMsg,
                    related_request_id: request_id,
                });

            } else {
                console.log(`☑️ Request ${request_id} de grupo ${group_id} ya existía (IGNORADA).`);
                // NO decrementes visitas ni loguees de nuevo si ya existía
            }
            // 👆👆👆 FIN DEL REEMPLAZO 👆👆👆

        } catch (err) {
            // Mejor log para identificar qué request falló
            const reqId = requestMsg ? requestMsg.request_id : 'desconocido';
            console.error(`Error procesando request ${reqId} de properties/requests:`, err);
        }
    }
    
});
