// src/web_server/services/boletaService.js
const { fetch: undiciFetch } = require('undici');
const _fetch = global.fetch || undiciFetch;

const BOLETA_API_URL = process.env.BOLETA_API_URL;

async function generarBoletaDesdeApiGateway({ requestRow, user, property }) {
  if (!BOLETA_API_URL) {
    throw new Error('BOLETA_API_URL not set');
  }

  const requestId = requestRow?.request_id || `req-${Date.now()}`;

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

  // 👇 AQUÍ la parte importante
  // si la Lambda ya trae public_url (porque le pusiste PUBLIC_BASE_URL), usamos esa
  const publicUrl = json.public_url;
  const signedUrl = json.url;

  if (publicUrl) {
    // esta la puedes guardar en la columna invoice_url
    return { url: publicUrl };
  }

  // fallback: si por alguna razón no hay public_url, devolvemos la firmada
  if (signedUrl) {
    return { url: signedUrl };
  }

  throw new Error(`Lambda /boleta respuesta inválida: ${JSON.stringify(json)}`);
}

module.exports = { generarBoletaDesdeApiGateway };
