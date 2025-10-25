    import PDFDocument from "pdfkit";
    import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
    import crypto from "crypto";

    /** Ajusta a la región de tu bucket S3 */
    // Asegúrate de que la región coincida con la región de tu bucket S3.
    // Si tu Lambda está en us-east-1 y tu bucket también, esto está bien.
    const s3 = new S3Client({ region: "us-east-1" });

    // Lee las variables de entorno configuradas EN LA LAMBDA
    const BUCKET_NAME = process.env.BUCKET_NAME;       // p.ej: propertiesmarket.tech
    const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;   // p.ej: https://propertiesmarket.tech.s3.amazonaws.com/invoices (¡SIN BARRA AL FINAL!)
    const INVOICE_SECRET = process.env.INVOICE_SECRET || ""; // secreto para firmar requests

    // Helper para respuestas de error
    function bad(status, message) {
      console.error(`Lambda Error Response: ${status} - ${message}`); // Log errors
      return {
        statusCode: status,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: message }),
      };
    }

    // Helper para respuestas exitosas
    function ok(data) {
       console.log("Lambda Success Response:", data); // Log success
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, ...data }),
      };
    }

    /** Verifica firma HMAC */
    function verifySignature(rawBody, signature) {
      if (!INVOICE_SECRET) {
         console.warn("INVOICE_SECRET not set in Lambda environment, skipping signature verification.");
         return true; // si no configuras secreto, omite verificación
      }
      if (!signature) {
         console.error("Signature verification failed: Missing x-invoice-signature header.");
         return false;
      }
      const h = crypto.createHmac("sha256", INVOICE_SECRET).update(rawBody).digest("hex");
      const expectedSignature = `sha256=${h}`;
      console.log(`Verifying signature. Received: ${signature}, Expected: ${expectedSignature}`);
      // acepta hex exacto o con prefijo sha256= (mejor comparar siempre con prefijo)
      const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
      if (!isValid && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(h))) {
         console.warn("Signature matched without sha256= prefix, accepting but recommend fixing sender.");
         return true; // Acepta sin prefijo por compatibilidad temporal
      }
       if (!isValid) {
         console.error("Signature verification failed: Signatures do not match.");
       }
      return isValid;
    }

    /** Genera un PDF simple en memoria y retorna un Buffer */
    async function buildPdfBuffer({ request_id, user, property, amount_clp }) {
      // (Mismo código que me mostraste antes - Asegúrate de que pdfkit esté en tus dependencias de Lambda si usas Layers/Packages)
      return new Promise((resolve, reject) => {
        try {
          const doc = new PDFDocument({ size: "A4", margin: 50 });
          const chunks = [];
          doc.on("data", (c) => chunks.push(c));
          doc.on("end", () => resolve(Buffer.concat(chunks)));
          doc.on("error", reject); // Añadir manejo de error

          // Encabezado
          doc
            .fontSize(20)
            .text("Boleta de Reserva", { align: "center" })
            .moveDown(0.5);
          doc
            .fontSize(10)
            .fillColor("#666")
            .text(`Folio: ${request_id}`, { align: "center" })
            .moveDown(1);

          // Datos comprador
          doc.fillColor("#000").fontSize(12).text("Datos del comprador", { underline: true });
          doc.moveDown(0.3);
          doc.fontSize(11);
          doc.text(`Nombre: ${user?.full_name ?? "N/A"}`);
          doc.text(`Email: ${user?.email ?? "N/A"}`);
          if (user?.phone) doc.text(`Teléfono: ${user.phone}`);
          doc.moveDown(1);

          // Datos propiedad
          doc.fontSize(12).text("Datos de la propiedad", { underline: true });
          doc.moveDown(0.3);
          doc.fontSize(11);
          doc.text(`URL: ${property?.data?.url ?? property?.url ?? "N/A"}`); // Usa property.url como fallback
          if (property?.location) doc.text(`Ubicación: ${property.location}`); // Accede directamente si no está en data
          if (property?.price) doc.text(`Precio referencial: ${property.price} ${property.currency ?? ""}`); // Accede directamente
          doc.moveDown(1);

          // Monto
          doc.fontSize(12).text("Detalle de pago", { underline: true });
          doc.moveDown(0.3);
          doc.fontSize(18).fillColor("#0a7f53").text(`Monto reserva: $${Number(amount_clp || 0).toLocaleString("es-CL")}`); // Asegura que amount_clp es número
          doc.moveDown(1);

          // Footer
          doc
            .fontSize(9)
            .fillColor("#666")
            .text(
              `Emitido automáticamente por PropertiesMarket · ${new Date().toLocaleString("es-CL")}`,
              { align: "center" }
            );

          doc.end();
        } catch (e) {
           console.error("Error building PDF:", e); // Log PDF generation error
          reject(e);
        }
      });
    }

    export const handler = async (event) => {
      console.log("Lambda Invoked. Event:", JSON.stringify(event, null, 2)); // Log incoming event

      // Verifica variables de entorno cruciales al inicio
       if (!BUCKET_NAME || !PUBLIC_BASE_URL || !INVOICE_SECRET) {
         console.error("FATAL: Lambda environment variables missing (BUCKET_NAME, PUBLIC_BASE_URL, INVOICE_SECRET)");
         return bad(500, "Lambda configuration error: Missing environment variables");
       }

      try {
        // Soporta invocación vía Function URL / API Gateway
        const rawBody = typeof event?.body === "string" ? event.body : JSON.stringify(event?.body || {});
         console.log("Raw Body:", rawBody);
        const headers = Object.fromEntries(
          Object.entries(event?.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
        );
        const sig = headers["x-invoice-signature"];
        console.log("Received Signature:", sig);

        if (!verifySignature(rawBody, sig)) {
          return bad(401, "Invalid signature");
        }
        console.log("Signature verified successfully.");

        const body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
        console.log("Parsed Body:", body);
        const { request_id, user, property, amount_clp } = body || {};

        if (!request_id) return bad(400, "Missing request_id");
        if (!Number.isFinite(Number(amount_clp))) return bad(400, "Missing or invalid amount_clp");

        console.log(`Generating PDF for request_id: ${request_id}`);
        // 1) Generar PDF en memoria
        const pdfBuffer = await buildPdfBuffer({ request_id, user, property, amount_clp });
        console.log(`PDF generated successfully. Buffer size: ${pdfBuffer.length} bytes.`);

        // 2) Subir a S3
        const key = `invoices/${request_id}.pdf`;
        console.log(`Uploading PDF to S3: Bucket=${BUCKET_NAME}, Key=${key}`);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
          Body: pdfBuffer,
          ContentType: "application/pdf",
        }));
        console.log("PDF uploaded successfully to S3.");

        // 3) Responder URL pública (asegúrate que PUBLIC_BASE_URL no tenga / al final)
        const invoice_url = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/${request_id}.pdf`;
        console.log(`Generated invoice_url: ${invoice_url}`);
        return ok({ invoice_url });

      } catch (err) {
        console.error("Lambda handler error:", err); // Log the detailed error
        return bad(500, err?.message || "Internal error generating invoice");
      }
    };
    
