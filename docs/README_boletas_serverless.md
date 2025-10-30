# Boletas PDF – Despliegue con Serverless Framework (RDOC3)

Generación de **boletas en PDF** mediante **AWS Lambda** expuesta por **API Gateway (HTTP API)**, almacenamiento en **S3** (privado) y **URL firmadas** para descarga. Este documento explica **qué hacer primero y qué después** para desplegar y usar el servicio desde tu backend Koa.

---

## 1) Prerrequisitos

- Cuenta AWS con credenciales configuradas localmente (`aws configure`) y permisos para **Lambda**, **API Gateway**, **S3** e **IAM**.
- **Node.js 20.x** y **npm**.
- **Serverless Framework v3** (puedes usar `npx` sin instalar globalmente).

> Proyecto base esperado:
>
> ```text
> boletas-serverless/
> ├─ src/
> │  └─ handler.js
> ├─ serverless.yml
> └─ package.json
> ```

---

## 2) Configuración principal

La configuración por defecto del proyecto ya define:
- **Función**: `generarBoleta` (`POST /boleta`).
- **Bucket S3 privado** con cifrado SSE-S3 y lifecycle (prefijo `invoices/`).
- **Variables de entorno** en la Lambda:
  - `BUCKET_NAME`: nombre del bucket (se genera único por `service-stage-account-region`).
  - `PUBLIC_BASE_URL`: base teórica pública a `invoices/` (bucket sigue privado).
  - `INVOICE_PREFIX`: `invoices`.
  - `BRAND_NAME`, `BRAND_COLOR`, `BRAND_SUBTITLE`: branding PDF.
  - `SIGNED_URL_TTL`: TTL de URL firmada (segundos).

La **policy IAM** limita los accesos a `invoices/*` en el bucket.

---

## 3) Instalar dependencias

```bash
cd boletas-serverless
npm ci
```

---

## 4) Desplegar con Serverless (stage dev)

```bash
npx serverless deploy -s dev
```

Al finalizar verás el **endpoint** de API Gateway (HTTP API). Si necesitas verlo de nuevo:

```bash
npx serverless info -s dev
# Copia la URL que termina con /boleta
```

---

## 5) Configurar el backend Koa

Edita `.env` de tu **web_server** para que el backend sepa dónde invocar la API de boletas:

```env
BOLETA_API_URL=https://<tu-id>.execute-api.<region>.amazonaws.com/boleta
```

Reinicia el backend después de guardar.

---

## 6) Probar la API /boleta manualmente

```bash
API="https://<tu-id>.execute-api.<region>.amazonaws.com/boleta"
curl -s -X POST "$API" \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id":"REQ-demo-123",
    "amount_clp": 15990,
    "property": { "name":"Depto demo", "url":"https://ejemplo.com/p/1" }
  }'
```

Respuesta esperada (ejemplo):

```json
{
  "ok": true,
  "url": "https://s3...X-Amz-Signature=...",
  "public_url": "https://<bucket>.s3.<region>.amazonaws.com/invoices/REQ-demo-123.pdf",
  "key": "invoices/REQ-demo-123.pdf"
}
```

---

## 7) Integración en el flujo de pago

Cuando Webpay devuelve **ACCEPTED**, tu backend llama a `BOLETA_API_URL` (vía `generarBoletaDesdeApiGateway`), recibe la URL firmada y la guarda como `invoice_url` en la fila `purchase_requests`.  
Luego el front navega a `/reservations/:request_id/invoice` y el backend **redirige** a esa `invoice_url`.

---

## 8) Operación básica

- **Logs** de la función en vivo:
  ```bash
  npx serverless logs -f generarBoleta -s dev --tail
  ```

- **Volver a desplegar** tras cambios:
  ```bash
  npx serverless deploy -s dev
  ```

- **Eliminar** la infraestructura (vacía el bucket antes si corresponde):
  ```bash
  npx serverless remove -s dev
  ```

---

## 9) Ejemplo de payload estable

```json
{
  "request_id": "REQ-123",
  "amount_clp": 12000,
  "property": {
    "name": "Depto Ñuñoa 2D1B",
    "url": "https://tusitio.com/p/123"
  },
  "usuario": {
    "nombre": "Viki",
    "email": "viki@example.com",
    "rut": "11.111.111-1"
  },
  "metadata": {
    "ordenId": "G9-ABCDEFG",
    "fecha": "2025-10-30T11:00:00.000Z"
  }
}
```

---

## 10) Resumen “qué va primero y qué después”

1. **Instala** dependencias (`npm ci` en `boletas-serverless/`).  
2. **Despliega** con Serverless (`npx serverless deploy -s dev`).  
3. **Copia** el endpoint `/boleta` desde `npx serverless info -s dev`.  
4. **Configura** `BOLETA_API_URL` en `.env` del backend Koa y **reinícialo**.  
5. **Prueba** con `curl` que la API retorne una URL firmada.  
6. **Habilita** el flujo automático tras Webpay **ACCEPTED** (backend guarda `invoice_url`).  
7. **Usa** `/reservations/:request_id/invoice` para redirigir a la boleta PDF.
