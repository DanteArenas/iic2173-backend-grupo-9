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
const Auction = require('../web_server/models/Auction');
const Proposal = require('../web_server/models/ExchangeProposal');
const sequelize = require('../web_server/database');
const EventLog = require('../web_server/models/EventLog');
const { ensureDbSchemaUpgrades } = require('../web_server/services/schemaService');
const client = require('./mqttClient');
const { withFibonacciRetry } = require('./retry');

const missingRequestWarnings = new Set();


// =========================
// Fetch de machine token
// =========================
const auth0IssuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
const auth0Audience = process.env.AUTH0_AUDIENCE;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;
const auth0ClientSecret = process.env.AUTH0_CLIENT_SECRET;

(async () => {
    try {
        await sequelize.authenticate();
        await ensureDbSchemaUpgrades(sequelize);
        console.log('📦 Listener conectado a DB y esquema actualizado.');
    } catch (err) {
        console.error('❌ Listener no pudo preparar la base de datos:', err);
    }
})();

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
        subscribeWithRetry('properties/auctions'),
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
        let relatedRequestId = null;
        try {
            validation = JSON.parse(message.toString());
            if (String(validation.group_id) === String(process.env.GROUP_ID)) {
             console.log(`🛑 Validación propia recibida (${validation.request_id}). Ignorando update de BD para evitar bucle.`);
             return; 
        }

            console.log('📩 Validación recibida:', validation);

            requestId = validation.request_id;
            status = validation.status;
            const { reason } = validation;

            const request = await Request.findOne({ where: { request_id: requestId } });
            if (request) {
                relatedRequestId = requestId;
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
            } else if (!missingRequestWarnings.has(requestId)) {
                missingRequestWarnings.add(requestId);
                console.warn(`⚠️ Request ${requestId} no encontrado en DB (probablemente pertenece a otro grupo o llegó sin request previo).`);
            }
        } catch (err) {
            console.error('❌ Error procesando validación:', err);
        }

        if (validation && status) {
            await EventLog.create({
                type: `VALIDATION_${status.toUpperCase()}`,
                payload: validation,
                related_request_id: relatedRequestId || null,
            });
        }
    }


    // Dentro de client.on('message', ...)
    if (topic === 'properties/requests-1') {
        let requestMsg; // Definir fuera para usar en catch
        try {
            requestMsg = JSON.parse(message.toString());
            console.log("📩 Request recibida:", requestMsg);

            const { request_id, group_id, url, amount_clp } = requestMsg; // Extraer amount_clp si viene

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
            const [, created] = await Request.findOrCreate({
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
    

        } catch (err) {
            // Mejor log para identificar qué request falló
            const reqId = requestMsg ? requestMsg.request_id : 'desconocido';
            console.error(`Error procesando request ${reqId} de properties/requests:`, err);
        }
    }
    if (topic === 'properties/auctions') {
    let msg;

    try {
        msg = JSON.parse(message.toString());
        console.log("📩 Mensaje AUCTION recibido:", msg);
    } catch (err) {
        console.error("❌ Error parseando mensaje de auctions:", err);
        return;
    }

    const {
        auction_id,
        proposal_id,
        url,
        timestamp,
        quantity,
        group_id,
        operation
    } = msg;

    // Tu grupo
    const myGroup = Number(process.env.GROUP_ID);

    // ===================================================
    // 1. OFFER → otro grupo subasta sus visitas
    // ===================================================
    if (operation === "offer") {

        // Ignorar mis propias ofertas
        if (group_id === myGroup) {
        console.log("🔁 Offer propio, ignorado.");
        return;
        }

        console.log("📥 Registrando offer de otro grupo…");

        await Auction.findOrCreate({
        where: { auction_id },
        defaults: {
            auction_id,
            owner_group_id: group_id,
            url,
            quantity,
            timestamp,
            status: "OPEN",
        }
        });

        await EventLog.create({
        type: "AUCTION_OFFER_RECEIVED",
        payload: msg,
        });

        return;
    }

    // ===================================================
    // 2. PROPOSAL → otro grupo te ofrece un intercambio
    // ===================================================
    if (operation === "proposal") {

        const auction = await Auction.findOne({ where: { auction_id }});
        if (!auction) {
        console.warn(`⚠️ Propuesta recibida para auction no existente (${auction_id}).`);
        return;
        }

        // Si NO soy el dueño original de la subasta → la propuesta NO es para mi
        if (auction.owner_group_id !== myGroup) {
        console.log("📤 Proposal para otro grupo, ignorado.");
        return;
        }

        console.log("📥 Registrando propuesta recibida…");

        await Proposal.findOrCreate({
        where: { proposal_id },
        defaults: {
            proposal_id,
            auction_id,
            from_group_id: group_id,
            to_group_id: myGroup,
            url,
            quantity,
            timestamp,
            status: "PENDING"
        }
        });

        await EventLog.create({
        type: "AUCTION_PROPOSAL_RECEIVED",
        payload: msg,
        });

        return;
    }

    // ===================================================
    // 3. ACCEPTANCE → aceptaron tu propuesta
    // ===================================================
    if (operation === "acceptance") {

        const proposal = await Proposal.findOne({ where: { proposal_id }});
        if (!proposal) {
        console.warn("⚠️ Acceptance de propuesta no registrada:", proposal_id);
        return;
        }

        // Si YO soy el grupo que ofreció
        if (proposal.from_group_id === myGroup) {
        console.log("🎉 Una de mis propuestas fue ACEPTADA!");

        await proposal.update({ status: "ACCEPTED" });

        // Cerrar la subasta localmente
        await Auction.update(
            { status: "CLOSED" },
            { where: { auction_id } }
        );

        await EventLog.create({
            type: "AUCTION_PROPOSAL_ACCEPTED",
            payload: msg,
        });

        // Aquí podrías actualizar tus reservas:
        // +quantity para lo que recibiste
        // -quantity para lo que ofreciste (si corresponde)

        }

        return;
    }

    // ===================================================
    // 4. REJECTION → rechazaron tu propuesta
    // ===================================================
    if (operation === "rejection") {

        const proposal = await Proposal.findOne({ where: { proposal_id }});
        if (!proposal) {
        console.warn("⚠️ Rejection de propuesta no registrada:", proposal_id);
        return;
        }

        if (proposal.from_group_id === myGroup) {
        console.log("❌ Mi propuesta fue rechazada.");

        await proposal.update({ status: "REJECTED" });

        await EventLog.create({
            type: "AUCTION_PROPOSAL_REJECTED",
            payload: msg,
        });
        }

        return;
    }

    console.warn("⚠️ Operación desconocida en auctions:", operation);
    }
    
});
