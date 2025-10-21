// src/web_server/services/webpayService.js
const {
  WebpayPlus,
  Options,
  IntegrationApiKeys,
  IntegrationCommerceCodes,
  Environment
} = require("transbank-sdk");

// Configuración en ambiente de integración
const tx = new WebpayPlus.Transaction(
  new Options(
    IntegrationCommerceCodes.WEBPAY_PLUS,
    IntegrationApiKeys.WEBPAY,
    Environment.Integration
  )
);

// Crea una transacción y devuelve token + URL
async function createTransaction(buyOrder, sessionId, amount, returnUrl) {
  return await tx.create(buyOrder, sessionId, amount, returnUrl);
}

// Confirma una transacción con el token recibido en returnUrl
async function commitTransaction(token) {
  return await tx.commit(token);
}

function mapWebpayStatus(result) {
  if (result.status === "AUTHORIZED" && result.response_code === 0) {
    return "ACCEPTED"; // Pago exitoso
  }
  if (result.status === "FAILED" || result.status === "REVERSED") {
    return "REJECTED"; // Pago rechazado
  }
  if (result.status === "ABORTED" || result.status === "NULLIFIED") {
    return "ERROR"; // Usuario salió o hubo error técnico
  }
  return "ERROR"; // fallback
}

module.exports = {
  createTransaction,
  commitTransaction,
  mapWebpayStatus
};
