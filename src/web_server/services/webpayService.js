// src/web_server/services/webpayService.js
const {
  WebpayPlus,
  Options,
  IntegrationApiKeys,
  IntegrationCommerceCodes,
  Environment
} = require("transbank-sdk");

/**
 * Modo efectivo: Integration (TEST) por defecto.
 * Solo usamos variables de entorno si es PRODUCTION.
 */
const mode = (process.env.WEBPAY_ENV || "TEST").toUpperCase();

let tx;
if (mode === "PRODUCTION") {
  const commerceCode = process.env.WEBPAY_COMMERCE_CODE;
  const apiKey = process.env.WEBPAY_API_KEY;
  if (!commerceCode || !apiKey) {
    throw new Error(
      "WEBPAY_ENV=PRODUCTION requiere WEBPAY_COMMERCE_CODE y WEBPAY_API_KEY configurados"
    );
  }
  console.log(
    `[Webpay] PRODUCTION enabled. commerceCode=${commerceCode} (apiKey oculto)`
  );
  tx = new WebpayPlus.Transaction(
    new Options(commerceCode, apiKey, Environment.Production)
  );
} else {
  // Integration fijo (lo que te funcionó en el test directo)
  console.log(
    `[Webpay] INTEGRATION enabled. Using Transbank integration constants.`
  );
  tx = new WebpayPlus.Transaction(
    new Options(
      IntegrationCommerceCodes.WEBPAY_PLUS, // 597055555532
      IntegrationApiKeys.WEBPAY,            // clave de integración válida
      Environment.Integration
    )
  );
}

// Crea una transacción y devuelve token + URL
async function createTransaction(buyOrder, sessionId, amount, returnUrl) {
  if (!returnUrl) {
    throw new Error("createTransaction: returnUrl es requerido");
  }
  return await tx.create(buyOrder, sessionId, amount, returnUrl);
}

// Confirma una transacción con el token recibido en returnUrl (POST)
async function commitTransaction(token) {
  if (!token) {
    throw new Error("commitTransaction: token es requerido");
  }
  return await tx.commit(token);
}

// Mapea la respuesta de Transbank a tus estados internos
function mapWebpayStatus(result) {
  if (result?.status === "AUTHORIZED" && result?.response_code === 0) {
    return "ACCEPTED"; // Pago exitoso
  }
  if (result?.status === "FAILED" || result?.status === "REVERSED") {
    return "REJECTED"; // Pago rechazado
  }
  if (result?.status === "ABORTED" || result?.status === "NULLIFIED") {
    return "ERROR"; // Usuario salió o error técnico
  }
  return "ERROR"; // fallback
}

module.exports = {
  createTransaction,
  commitTransaction,
  mapWebpayStatus
};
