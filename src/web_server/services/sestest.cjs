const path = require('path');
// Load root .env (repo/.env): services -> web_server -> src -> repo root
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const { sendEmail, sendPaymentNotification } = require('./emailService');
const DEFAULT_TEST_TO = 'dante.arenas@uc.cl';

// Usage:
//   node services/sestest.cjs                 -> simple test email
//   node services/sestest.cjs payment [status] -> simulated purchase email (status optional: ACCEPTED|REJECTED|ERROR)

const cmd = (process.argv[2] || '').toLowerCase();
const statusArg = (process.argv[3] || 'ACCEPTED').toUpperCase();

async function simpleTest() {
    const to = DEFAULT_TEST_TO;
    await sendEmail(
        to,
        'Prueba SES',
        '<p>Hola! Este es un correo de prueba desde SES 😄</p>'
    );
    console.log('✅ Email de prueba enviado correctamente.');
}

async function paymentTest() {
    const to = DEFAULT_TEST_TO;
    const status = ['ACCEPTED', 'REJECTED', 'ERROR'].includes(statusArg) ? statusArg : 'ACCEPTED';
    await sendPaymentNotification({
        to,
        userName: process.env.TEST_USER_NAME || 'Usuario de Prueba',
        status,
        orderId: process.env.TEST_ORDER_ID || 'BO-TEST-123',
        reason: status === 'ACCEPTED' ? 'Pago aprobado' : (status === 'REJECTED' ? 'Pago rechazado' : 'Error técnico'),
        amount: Number(process.env.TEST_AMOUNT || 120000),
        propertyUrl: process.env.TEST_PROPERTY_URL || 'https://propertiesmarket.tech/property/TEST-123',
    });
    console.log(`✅ Email de compra simulado enviado (${status}).`);
}

(async () => {
    try {
        if (cmd === 'payment') {
            await paymentTest();
        } else {
            await simpleTest();
        }
    } catch (err) {
        console.error('❌ Error al enviar el correo:', err);
        process.exit(1);
    }
})();
