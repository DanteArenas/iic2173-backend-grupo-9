// src/web_server/services/boletaService.js
const { fetch: undiciFetch } = require('undici');
const _fetch = global.fetch || undiciFetch;

const BOLETA_API_URL = process.env.BOLETA_API_URL; // ej: https://zydjmvy0pa.execute-api.us-east-1.amazonaws.com/boleta
if (!BOLETA_API_URL) {
  console.warn('[boletaService] BOLETA_API_URL no está configurada en .env');
}

/**
 * Llama a la Lambda de "boletas-serverless" (API Gateway) y retorna { url, bucket, key }
 * requestRow: fila de purchase_requests
 * user: instancia de User
 * property: instancia de Property
 */
async function generarBoletaDesdeApiGateway({ requestRow, user, property }) {
  if (!BOLETA_API_URL) throw new Error('BOLETA_API_URL not set');

  // Datos base que tu Lambda /boleta espera
  const grupo = 'Grupo-9';
  const usuario = {
    nombre: user?.full_name || 'Usuario',
    email: user?.email || 'unknown@example.com',
    rut: user?.rut || '11.111.111-1',
  };

  const d = property?.data || {};
  // arma una “acción” genérica con lo que tienes; ajusta si quieres más info
  const accion = {
    ticker: 'LHG',
    nombre: d.name || 'LegitHomie Global',
    cantidad: 1,
    precioUnitario: Number(requestRow?.amount_clp) || 0, // tu monto de reserva
    moneda: 'CLP',
  };

  const metadata = {
    ordenId: requestRow?.buy_order || requestRow?.request_id || `ORD-${Date.now()}`,
    fecha: (requestRow?.created_at && new Date(requestRow.created_at).toISOString()) || new Date().toISOString(),
  };

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
  // { ok:true, bucket, key, url }
  if (!json?.ok || !json?.url) {
    throw new Error(`Lambda /boleta respuesta inválida: ${JSON.stringify(json)}`);
  }
  return { url: json.url, bucket: json.bucket, key: json.key };
}

module.exports = { generarBoletaDesdeApiGateway };
