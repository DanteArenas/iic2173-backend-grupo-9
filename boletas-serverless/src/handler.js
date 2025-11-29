import PDFDocument from "pdfkit";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"; // <— + GetObjectCommand
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"; // <— presigner

const REGION        = process.env.AWS_REGION || "us-east-1";
const BUCKET_NAME   = process.env.BUCKET_NAME;
const PUBLIC_BASE   = process.env.PUBLIC_BASE_URL || "";
const BRAND_NAME    = process.env.BRAND_NAME || "PropertiesMarket";
const BRAND_COLOR   = process.env.BRAND_COLOR || "#0a7f53";
const BRAND_SUB     = process.env.BRAND_SUBTITLE || "Boleta de Reserva";
const INVOICE_PREFIX = (process.env.INVOICE_PREFIX || "invoices").replace(/^\/|\/$/g, "");
const SIGNED_URL_TTL = Number(process.env.SIGNED_URL_TTL || 900);

const s3 = new S3Client({ region: REGION });
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const resolveOrigin = (requestOrigin) => {
  if (!allowedOrigins.length || allowedOrigins.includes("*")) return "*";
  if (!requestOrigin) return allowedOrigins[0];
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
};

const buildCorsHeaders = (originHeader) => {
  const origin = resolveOrigin(originHeader);
  const headers = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin !== "*") headers["Access-Control-Allow-Credentials"] = "true";
  return headers;
};
// ====== HELPERS ======
const fmtNumber = (n, decimals = 0) => {
  const v = Number(n ?? 0);
  const [int, dec = ""] = v.toFixed(decimals).split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return decimals ? `${intFmt},${dec}` : intFmt;
};

const fmtMoney = (value, currency) => {
  const v = Number(value ?? 0);
  const code = (currency || "CLP").toUpperCase();

  if (code === "UF") return `UF ${fmtNumber(v, 2)}`;
  if (code === "CLP") {
    try {
      return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(v);
    } catch {
      return `$${fmtNumber(v)} CLP`;
    }
  }
  if (code === "USD") {
    try {
      return new Intl.NumberFormat("es-CL", { style: "currency", currency: "USD" }).format(v);
    } catch {
      return `USD ${fmtNumber(v, 2)}`;
    }
  }
  return `${code} ${fmtNumber(v, 2)}`;
};

const detectCurrency = (p = {}) => {
  const cand = [p.moneda, p?.property?.currency, p?.accion?.moneda].find(Boolean);
  return (cand || "CLP").toUpperCase();
};

const pickAmount = (p = {}) => {
  // Prioriza un campo claro de reserva; si no, cae a CLP o a unitario*cantidad
  if (Number.isFinite(Number(p.precio_reserva))) return Number(p.precio_reserva);
  if (Number.isFinite(Number(p.amount_clp))) return Number(p.amount_clp);
  if (Number.isFinite(Number(p?.accion?.precioUnitario))) {
    const cant = Number(p?.accion?.cantidad ?? 1);
    return Number(p.accion.precioUnitario) * cant;
  }
  if (Number.isFinite(Number(p?.property?.price))) return Number(p.property.price);
  return 0;
};


const getReservedAt = (p = {}) =>
  p.reserved_at || p.created_at || p.timestamp || new Date().toISOString();

const fch = (isoStr) => {
  try {
    return new Intl.DateTimeFormat("es-CL", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Santiago",
    }).format(new Date(isoStr));
  } catch {
    return new Date(isoStr).toLocaleString("es-CL");
  }
};

const divider = (doc) => {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y + 2;
  doc.save().moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor("#e5e7eb").stroke().restore();
  doc.moveDown(0.6);
};

const section = (doc, title) => {
  doc.moveDown(0.6);
  doc.fillColor("#111").fontSize(12).text(title, { underline: true });
  doc.moveDown(0.2);
};

const drawKV = (doc, k, v, opts = {}) => {
  const { keyColor = "#666", valueColor = "#0f172a", width } = opts;
  const contentWidth = width ?? (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  doc.fillColor(keyColor).fontSize(10).text(k);
  doc.fillColor(valueColor).fontSize(11).text(String(v ?? "—"), { width: contentWidth });
  doc.moveDown(0.2);
};

const header = (doc, request_id) => {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;

  doc.save().rect(left, 40, width, 50).fill(BRAND_COLOR).restore();
  doc.fillColor("#fff").fontSize(18).text(BRAND_NAME, left + 16, 55, { continued: true });
  doc.fontSize(12).fillColor("#eafaf2").text(`  •  ${BRAND_SUB}`);

  const fecha = fch(new Date().toISOString());
  doc.fontSize(10).fillColor("#f0fdf4").text(fecha, { align: "right" });

  doc.moveDown(1.4);
  doc.fillColor("#111").fontSize(20).text("Comprobante de Reserva", { align: "left" });
  doc.fontSize(10).fillColor("#666").text(`Folio: ${request_id}`, { align: "left" });
  divider(doc);
};

// ====== PDF BUILDER (UNA COLUMNA, SIN DESBORDES) ======
const buildPdfBuffer = async (p = {}) => new Promise((resolve, reject) => {
  try {
    const request_id   = p.request_id || `REQ-${Date.now()}`;
    const reservedAt   = getReservedAt(p);
    const propertyName = p?.property?.name || p?.accion?.nombre || "—";
    const propertyUrl  = p?.metadata?.propertyUrl || p?.property?.url || null;

    const currency = detectCurrency(p);
    const amount   = pickAmount(p);

    const doc = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: 50, right: 50 } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // HEADER
    header(doc, request_id);

    // RESUMEN
    section(doc, "Resumen");
    drawKV(doc, "Propiedad", propertyName, { width: contentWidth });

    if (propertyUrl) {
      doc.fillColor("#666").fontSize(10).text("Ficha de la propiedad");
      doc.fillColor("#0ea5e9").fontSize(11).text("Ver ficha", {
        link: propertyUrl,
        underline: true,
        width: contentWidth
      });
      doc.moveDown(0.2);
    }

    drawKV(doc, "Fecha y hora de la reserva", fch(reservedAt), { width: contentWidth });

    // TOTAL (tarjeta)
    doc.moveDown(0.8);
    divider(doc);
    section(doc, "Pago");

    const boxX = doc.page.margins.left;
    const boxW = contentWidth;
    const boxH = 68;
    const y0 = doc.y + 5;

    doc.save()
      .roundedRect(boxX, y0, boxW, boxH, 10)
      .fill("#f5fef9")
      .restore();

    doc.save();
    doc.fillColor(BRAND_COLOR).fontSize(12).text("Precio de la reserva", boxX + 16, y0 + 12, { width: boxW - 32 });
    doc.fontSize(24).fillColor("#0f172a").text(fmtMoney(amount, currency), boxX + 16, y0 + 34);
    doc.restore();

    doc.moveDown(5);

    // NOTA FORMAL
    section(doc, "Nota");
    doc.fillColor("#444").fontSize(10).text(
      "Este comprobante ha sido emitido automáticamente por el sistema. " +
      "Por favor verifique que el correo de la cuenta, los datos de la propiedad, " +
      "la fecha/hora de la reserva y el precio sean correctos.",
      { align: "justify", width: contentWidth }
    );

    // FOOTER
    doc.moveDown(1.2);
    divider(doc);
    doc.fontSize(9).fillColor("#667085").text(
      `${BRAND_NAME} · ${fch(new Date().toISOString())} · Folio ${request_id}`,
      { align: "center", width: contentWidth }
    );

    doc.end();
  } catch (e) {
    reject(e);
  }
});

// ====== HANDLER ======

export const handler = async (event) => {
  const originHeader = event?.headers?.origin || event?.headers?.Origin || "";

  if (event?.requestContext?.http?.method === "OPTIONS") {
    return resp(204, null, originHeader);
  }

  try {
    if (!BUCKET_NAME) {
      return resp(500, { ok: false, error: "Missing BUCKET_NAME env" }, originHeader);
    }

    const bodyText = typeof event?.body === "string" ? event.body : JSON.stringify(event?.body || {});
    const payload  = bodyText ? JSON.parse(bodyText) : {};

    const requestId = payload.request_id || `REQ-${Date.now()}`;
    const pdfBuffer = await buildPdfBuffer(payload);

    const key = `${INVOICE_PREFIX}/${requestId}.pdf`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
    }));

    // URL pública teórica (por si algún día abres el bucket o pones CloudFront)
    const publicUrl = PUBLIC_BASE.replace(/\/$/, "")
      ? `${PUBLIC_BASE.replace(/\/$/, "")}/${requestId}.pdf`
      : `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${key}`;

    // ✅ URL firmada que funciona con bucket privado
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
      { expiresIn: SIGNED_URL_TTL }
    );

    // Para que el frontend siempre funcione, devolvemos la firmada en `url`
    return resp(200, { ok: true, url: signedUrl, public_url: publicUrl, key }, originHeader);

  } catch (err) {
    console.error("invoice handler error:", err);
    return resp(500, { ok: false, error: err?.message || "Internal error" }, originHeader);
  }
};

const resp = (statusCode, data, originHeader = "") => {
  const corsHeaders = buildCorsHeaders(originHeader);
  const body = data == null ? "" : JSON.stringify(data);
  const headers = {
    ...corsHeaders,
    ...(body ? { "content-type": "application/json" } : {}),
  };

  return {
    statusCode,
    headers,
    body,
  };
};

export { fmtMoney, pickAmount };
