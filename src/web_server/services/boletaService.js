// src/web_server/services/boletaService.js
const fs = require('fs');
const path = require('path');
const { fetch: undiciFetch } = require('undici');
const _fetch = global.fetch || undiciFetch;

const BOLETA_API_URL = process.env.BOLETA_API_URL; // ej: https://....execute-api.../boleta
if (!BOLETA_API_URL) {
  console.warn('[boletaService] BOLETA_API_URL no está configurada en .env');
}

// carpeta donde vamos a guardar las boletas de forma permanente
const INVOICES_DIR = path.join(__dirname, '..', 'invoices'); // src/web_server/invoices

// nos aseguramos de que exista
if (!fs.existsSync(INVOICES_DIR)) {
  fs.mkdirSync(INVOICES_DIR, { recursive: true });
}

/**
 * Llama a la Lambda que genera la boleta y guarda una copia local,
 * devolviendo la URL local estable (/invoices/<request_id>.pdf).
 *
 * @param {Object} params
 * @param {Object} params.requestRow - fila de purchase_requests
 * @param {Object} params.user - instancia de User
 * @param {Object} params.property - instancia de Property
 */
async function generarBoletaDesdeApiGateway({ requestRow, user, property }) {
  if (!BOLETA_API_URL) {
    throw new Error('BOLETA_API_URL not set');
  }

  const requestId = requestRow?.request_id || `req-${Date.now()}`;

  // datos que ya estabas mandando
  const grupo = 'Grupo-9';
  const usuario = {
    nombre: user?.full_name || 'Usuario',
    email: user?.email || 'unknown@example.com',
    rut: user?.rut || '11.111.111-1',
  };

  const d = property?.data || {};
  const accion = {
    ticker: 'LHG',
    nombre: d.name || 'LegitHomie Global',
    cantidad: 1,
    precioUnitario: Number(requestRow?.amount_clp) || 0,
    moneda: 'CLP',
  };

  const metadata = {
    ordenId: requestRow?.buy_order || requestId,
    fecha:
      (requestRow?.created_at && new Date(requestRow.created_at).toISOString()) ||
      new Date().toISOString(),
  };

  // 1) pedir a la Lambda que genere la boleta
  const res = await _fetch(BOLETA_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grupo, usuario, accion, metadata }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Lambda /boleta error ${res.status}: ${text}`);
  }

  const json = await res.json();
  // esperamos algo como { ok: true, url: 'https://s3....' }
  if (!json?.ok || !json?.url) {
    throw new Error(`Lambda /boleta respuesta inválida: ${JSON.stringify(json)}`);
  }

  // 2) descargar el PDF desde la URL temporal de S3
  const pdfRes = await _fetch(json.url);
  if (!pdfRes.ok) {
    throw new Error(`No se pudo descargar el PDF de la boleta desde S3 (${pdfRes.status})`);
  }

  const arrayBuffer = await pdfRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 3) guardar localmente con un nombre estable
  const filename = `${requestId}.pdf`;
  const filePath = path.join(INVOICES_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  // 4) construir URL pública estable que sirve Koa
  // OJO: aquí usamos la base del API si existe, si no, solo dejamos la ruta relativa
  const base =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.API_BASE_URL ||
    `http://localhost:${process.env.APP_PORT || 3000}`;
  const publicUrl = `${base.replace(/\/$/, '')}/invoices/${filename}`;

  // devolvemos la URL estable (no la temporal de S3)
  return { url: publicUrl, localPath: filePath };
}

module.exports = { generarBoletaDesdeApiGateway };
