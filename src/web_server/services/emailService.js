const nodemailer = require("nodemailer");
// Nodemailer v7 requiere SESv2
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

// Build transporter: prefer SESv2 API; auto-fallback to SMTP if needed
const getSesTransporter = () => {
    const transportMode = (process.env.EMAIL_TRANSPORT || 'sesv2').toLowerCase();
    const region = process.env.SES_REGION || "us-east-1";

    const buildSmtp = () => {
        const host = process.env.SES_SMTP_HOST || `email-smtp.${region}.amazonaws.com`;
        const port = Number(process.env.SES_SMTP_PORT || 587);
        const secure = process.env.SES_SMTP_SECURE ? process.env.SES_SMTP_SECURE === 'true' : port === 465;
        const user = process.env.SES_SMTP_USER;
        const pass = process.env.SES_SMTP_PASS;
        if (!user || !pass) {
            throw new Error('SES SMTP selected but SES_SMTP_USER/SES_SMTP_PASS are not set');
        }
        console.log(`📮 emailService: usando SES SMTP (${host}:${port}, secure=${secure})`);
        return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    };

    if (transportMode === 'ses-smtp') {
        return buildSmtp();
    }

    try {
        // Default: SESv2 API
        const sesClient = new SESv2Client({
            region,
            credentials: {
                accessKeyId: process.env.SES_ACCESS_KEY_ID,
                secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
            },
        });

        console.log(`📮 emailService: usando SESv2 API (region=${region})`);
        return nodemailer.createTransport({
            SES: { ses: sesClient, aws: { SendEmailCommand } },
        });
    } catch (e) {
        const msg = (e && e.message) || '';
        const legacy = e && (e.code === 'LegacyConfig' || msg.includes('Legacy'));
        if (legacy && process.env.SES_SMTP_USER && process.env.SES_SMTP_PASS) {
            console.warn('⚠️ SESv2 init falló con LegacyConfig, haciendo fallback a SES SMTP');
            return buildSmtp();
        }
        throw e;
    }
};

// Direct SESv2 API fallback (no Nodemailer)
async function sendEmailViaSesV2Direct({ to, subject, html, text, from }) {
    const region = process.env.SES_REGION || 'us-east-1';
    const sesClient = new SESv2Client({
        region,
        credentials: {
            accessKeyId: process.env.SES_ACCESS_KEY_ID,
            secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
        },
    });

    const toList = Array.isArray(to) ? to : [to];
    const body = text
        ? { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } }
        : { Html: { Data: html, Charset: 'UTF-8' } };

    const cmd = new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: toList },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: body,
            },
        },
    });
    const out = await sesClient.send(cmd);
    console.log('✅ Email enviado (SESv2 API directo):', out.MessageId || out?.$metadata?.requestId);
    return out;
}

const sendEmail = async (to, subject, htmlContent, textContent) => {
    const from = process.env.EMAIL_FROM || "notifications@propertiesmarket.tech";

    // 1) Try building transporter
    let transporter;
    try {
        transporter = getSesTransporter();
    } catch (e) {
        const msg = (e && e.message) || '';
        const legacy = e && (e.code === 'LegacyConfig' || msg.includes('Legacy'));
        if (legacy) {
            console.warn('⚠️ Nodemailer/SESv2 LegacyConfig al construir transporter. Usando SESv2 API directa.');
            return sendEmailViaSesV2Direct({ to, subject, html: htmlContent, text: textContent, from });
        }
        console.error('❌ Error construyendo transporter:', e);
        throw e;
    }

    // 2) Try sending via transporter
    try {
        const info = await transporter.sendMail({ from, to, subject, html: htmlContent, text: textContent });
        console.log("✅ Email enviado:", info.messageId);
        return info;
    } catch (e) {
        const msg = (e && e.message) || '';
        const legacy = e && (e.code === 'LegacyConfig' || msg.includes('Legacy'));
        if (legacy) {
            console.warn('⚠️ Nodemailer/SESv2 LegacyConfig al enviar. Usando SESv2 API directa.');
            return sendEmailViaSesV2Direct({ to, subject, html: htmlContent, text: textContent, from });
        }
        console.error('❌ Error enviando email:', e);
        throw e;
    }
};

const sendPaymentNotification = async ({ to, userName, status, orderId, reason, amount, propertyUrl }) => {
    const statusUpper = (status || '').toUpperCase();
    const accepted = statusUpper === 'ACCEPTED';

    const subject = accepted
        ? '✅ Pago confirmado - Properties Market'
        : statusUpper === 'REJECTED'
            ? '❌ Pago rechazado - Properties Market'
            : '⚠️ Actualización de pago - Properties Market';

    const friendlyAmount = typeof amount === 'number'
        ? amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })
        : amount || '';

    const greeting = userName ? `Hola ${userName},` : 'Hola,';

    const htmlContent = `
        <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height:1.6; color:#333; max-width:600px; margin:0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 24px;">Properties Market</h1>
            </div>
            
            <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none;">
                <p style="font-size: 16px; margin-bottom: 20px;">${greeting}</p>
                
                ${accepted
            ? `<p style="font-size: 16px; color: #10b981; font-weight: 600;">🎉 Tu pago ha sido <strong>confirmado exitosamente</strong>.</p>`
            : statusUpper === 'REJECTED'
                ? `<p style="font-size: 16px; color: #ef4444; font-weight: 600;">❌ Tu pago ha sido <strong>rechazado</strong>.</p>`
                : `<p style="font-size: 16px;">El estado de tu pago ha cambiado a: <strong>${statusUpper}</strong>.</p>`
        }
                
                <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #374151; font-size: 16px;">Detalles de la transacción:</h3>
                    <ul style="list-style: none; padding: 0; margin: 0;">
                        ${orderId ? `<li style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;"><strong>Orden:</strong> ${orderId}</li>` : ''}
                        ${friendlyAmount ? `<li style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;"><strong>Monto:</strong> ${friendlyAmount}</li>` : ''}
                        ${reason ? `<li style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;"><strong>Detalle:</strong> ${reason}</li>` : ''}
                        ${propertyUrl ? `<li style="padding: 8px 0;"><strong>Propiedad:</strong> <a href="${propertyUrl}" style="color: #667eea; text-decoration: none;">${propertyUrl}</a></li>` : ''}
                    </ul>
                </div>
                
                <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
                    Gracias por usar nuestro servicio.
                </p>
            </div>
            
        </div>
    `;
    const lines = [
        greeting,
        accepted
            ? 'Tu pago ha sido confirmado exitosamente.'
            : statusUpper === 'REJECTED'
                ? 'Tu pago ha sido rechazado.'
                : `El estado de tu pago ha cambiado a: ${statusUpper}.`,
        orderId ? `Orden: ${orderId}` : null,
        friendlyAmount ? `Monto: ${friendlyAmount}` : null,
        reason ? `Detalle: ${reason}` : null,
        propertyUrl ? `Propiedad: ${propertyUrl}` : null,
        '',
        'Gracias por usar nuestro servicio.'
    ].filter(Boolean);
    const textContent = lines.join('\n');

    return sendEmail(to, subject, htmlContent, textContent);
};

module.exports = {
    sendEmail,
    sendPaymentNotification,
    getSesTransporter
};