// src/web_server/services/invoiceService.js

const crypto = require('crypto');
const { fetch: undiciFetch } = require('undici');

// usamos fetch de Node 18+/undici
const _fetch = global.fetch || undiciFetch;

// estas vienen del contenedor (docker-compose / variables de entorno)
const INVOICE_LAMBDA_URL = process.env.INVOICE_LAMBDA_URL; // ej https://4z5vzwuephrih3wnz45m4bjz3u0llzgj.lambda-url.us-east-2.on.aws/
const INVOICE_SECRET = process.env.INVOICE_SECRET || '';   // ej aJd82Hs93Kjs9ah1LmZ
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // ej https://propertiesmarket.tech.s3.amazonaws.com/invoices

/**
 * arma el body que le mandamos a la Lambda
 * requestRow: fila de purchase_requests (la reserva/pago)
 * user: instancia de User del dueño de la reserva
 * property: instancia de Property asociada
 */
function buildLambdaPayload({ requestRow, user, property }) {
  if (!requestRow) {
    throw new Error('buildLambdaPayload: missing requestRow');
  }

  // info básica de la propiedad
  const propData = property && property.data ? property.data : {};

  return {
    request_id: requestRow.request_id,
    buy_order: requestRow.buy_order || null,
    amount_clp: requestRow.amount_clp || 0,
    status: requestRow.status || null,
    created_at: requestRow.created_at || new Date().toISOString(),

    user: {
      id: requestRow.user_id,
      full_name: user?.full_name || null,
      email: user?.email || null,
    },

    property: {
      url: propData.url || requestRow.property_url || null,
      name: propData.name || null,
      location: propData.location || null,
      price: propData.price || null,
      currency: propData.currency || null,
    },
  };
}

/**
 * firma HMAC-SHA256 del body JSON para que Lambda compruebe autenticidad
 */
function signBody(bodyString) {
  return crypto
    .createHmac('sha256', INVOICE_SECRET)
    .update(bodyString)
    .digest('hex');
}

/**
 * Llama a la Lambda para generar/subir la boleta y retorna la URL pública final.
 * Si Lambda responde bien con { ok:true, invoice_url: "https://..." }
 * devolvemos esa invoice_url.
 *
 * En caso de éxito parcial donde Lambda no mande invoice_url,
 * devolvemos un fallback construido con PUBLIC_BASE_URL + request_id.pdf
 * (por si la Lambda y el backend acordaron ese esquema).
 */
async function generateAndUploadInvoice({ requestRow, user, property }) {
  // --- INICIO DEBUG ---
  console.log(`[generateAndUploadInvoice] Iniciando para request_id: ${requestRow?.request_id}`);
  console.log(`[generateAndUploadInvoice] Usando Lambda URL: ${INVOICE_LAMBDA_URL}`);
  console.log(`[generateAndUploadInvoice] Usando INVOICE_SECRET: ${INVOICE_SECRET ? '***DEFINIDO***' : '!!!NO DEFINIDO!!!'}`);
  // --- FIN DEBUG ---

  if (!INVOICE_LAMBDA_URL) {
    console.error('[generateAndUploadInvoice] Error: INVOICE_LAMBDA_URL no está definida.'); // Log adicional
    throw new Error('generateAndUploadInvoice: INVOICE_LAMBDA_URL is not defined');
  }
  if (!INVOICE_SECRET) {
     console.error('[generateAndUploadInvoice] Error: INVOICE_SECRET no está definida.'); // Log adicional
    throw new Error('generateAndUploadInvoice: INVOICE_SECRET is not defined');
  }

  const payload = buildLambdaPayload({ requestRow, user, property });
  const bodyString = JSON.stringify(payload);
  const signature = signBody(bodyString);

  // --- INICIO DEBUG ---
  console.log(`[generateAndUploadInvoice] Payload para Lambda:`, payload);
  console.log(`[generateAndUploadInvoice] Signature: ${signature}`);
  console.log(`[generateAndUploadInvoice] Llamando a fetch a ${INVOICE_LAMBDA_URL}...`);
  // --- FIN DEBUG ---

  // POST a la lambda
  const resp = await _fetch(INVOICE_LAMBDA_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-invoice-signature': `sha256=${signature}`, // <-- ¿Está así?
      },
    body: bodyString,
  });

  // --- INICIO DEBUG ---
  console.log(`[generateAndUploadInvoice] Respuesta de Lambda recibida. Status: ${resp.status}`);
  // --- FIN DEBUG ---

  let data;
  let responseBodyText = ''; // Para guardar el cuerpo si no es JSON
  try {
    // Intenta leer como JSON primero
    responseBodyText = await resp.text(); // Lee el cuerpo como texto
    data = JSON.parse(responseBodyText); // Intenta parsear
    // --- INICIO DEBUG ---
    console.log(`[generateAndUploadInvoice] Cuerpo de respuesta Lambda (JSON):`, data);
    // --- FIN DEBUG ---
  } catch (e) {
    // --- INICIO DEBUG ---
    console.error(`[generateAndUploadInvoice] Error parseando JSON de Lambda. Status ${resp.status}. Body: ${responseBodyText}`, e);
    // --- FIN DEBUG ---
    data = null; // Falla el parseo JSON
  }

  if (!resp.ok) {
    // Usa el mensaje de error del JSON si existe, si no, usa el status HTTP
    const msg = data && data.error ? data.error : `Lambda HTTP ${resp.status} - Body: ${responseBodyText}`;
    // --- INICIO DEBUG ---
    console.error(`[generateAndUploadInvoice] Lambda devolvió error: ${msg}`);
    // --- FIN DEBUG ---
    throw new Error(`generateAndUploadInvoice: lambda error: ${msg}`);
  }

  if (!data || data.ok !== true) {
     // --- INICIO DEBUG ---
     console.error(`[generateAndUploadInvoice] Respuesta inválida (no JSON o ok!=true) de Lambda:`, data || responseBodyText);
     // --- FIN DEBUG ---
    throw new Error(
      `generateAndUploadInvoice: invalid lambda response: ${JSON.stringify(data) || responseBodyText}`
    );
  }

  // preferimos la URL que genera la lambda
  if (data.invoice_url && typeof data.invoice_url === 'string') {
    // --- INICIO DEBUG ---
    console.log(`[generateAndUploadInvoice] Lambda devolvió invoice_url: ${data.invoice_url}`);
    // --- FIN DEBUG ---
    return data.invoice_url;
  }

  // fallback: usamos PUBLIC_BASE_URL/request_id.pdf si PUBLIC_BASE_URL está seteada
  if (PUBLIC_BASE_URL && requestRow.request_id) {
     const fallbackUrl = `${PUBLIC_BASE_URL}/${requestRow.request_id}.pdf`;
     // --- INICIO DEBUG ---
     console.warn(`[generateAndUploadInvoice] Lambda no devolvió invoice_url, usando fallback: ${fallbackUrl}`);
     // --- FIN DEBUG ---
     return fallbackUrl;
  }

   // --- INICIO DEBUG ---
   console.error(`[generateAndUploadInvoice] Lambda OK pero invoice_url falta y no hay fallback.`);
   // --- FIN DEBUG ---
  throw new Error('generateAndUploadInvoice: lambda OK but invoice_url missing');
}

module.exports = {
  generateAndUploadInvoice,
};
