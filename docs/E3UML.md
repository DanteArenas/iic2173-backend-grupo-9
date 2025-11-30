# RDOC1 — Diagrama UML 

## 1. Frontend (CloudFront + S3)

El frontend es una SPA desplegada en un bucket S3 y distribuida mediante CloudFront.

### Responsabilidades
- Mostrar propiedades, compras, recomendaciones y subastas.
- Iniciar pagos WebPay.
- Consumir API REST mediante API Gateway.
- Mantener sesión con Auth0 (JWT).
- Recibir actualizaciones en tiempo real vía WebSockets.
- Descargar boletas PDF generadas en AWS Lambda.

### Conexiones
- API Gateway  
- WebPay  
- WebSocket Service  
- Auth0  

---

## 2. API Gateway (REST API)

Punto de entrada seguro para llamadas del frontend hacia el backend.

### Responsabilidades
- Validación de JWT usando Custom Authorizer.
- Enrutar solicitudes a la API interna.
- Manejo de callbacks de WebPay.
- Bloquear accesos no autorizados según rol.

---

## 3. Backend Principal (EC2 + Docker)

El backend se ejecuta en una EC2 usando contenedores Docker.

### Componentes internos

### NGINX Reverse Proxy
- Maneja HTTPS y redirige tráfico hacia la API.

### API 


### Base de Datos (PostgreSQL / RDS)
Almacena:
- Usuarios y roles  
- Propiedades  
- Compras  
- Subastas y propuestas  
- Recomendaciones  
- Eventos MQTT  
- Boletas  

---

## 4. MQTT Broker (IIC2173)

Núcleo del sistema asíncrono.

### Canales
- `properties/info`  
- `properties/requests`  
- `properties/validation`  
- `properties/auctions`  

### MQTT Subscriber
- Escucha todos los canales.
- Actualiza la base de datos.
- Dispara eventos en WebSocket.

---

## 5. WebSocket Service (EC2)

Servicio dedicado exclusivamente a comunicación en tiempo real.

### Responsabilidades
- Notificar actualizaciones de compras.
- Notificar validaciones.
- Notificar cambios en subastas/intercambios.

---

## 6. JobMaster + Workers (EC2 Separada)

Sistema de workers requerido para recomendaciones tras cada compra.

### JobMaster
- `POST /job`  
- `GET /job/:id`  
- `GET /heartbeat`  

### Workers (Bull.js/Redis)
- Consumen cola de recomendaciones.
- Calculan 3 propiedades recomendadas basadas en comuna, ubicación, precio y dormitorios.

---

## 7. AWS Lambda (GenerateInvoice)

Función serverless para generación de boletas PDF.

### Responsabilidades
- Generar PDF con datos de la compra.
- Subirlo a S3.
- Retornar URL pública al backend.

---

## 8. Amazon SES

Responsable de enviar el correo al usuario al finalizar una compra aprobada o rechazada.

---

## 9. Auth0

Servicio de autenticación y autorización externa.

### Responsabilidades
- Login/Logout.
- Entrega de tokens JWT.
- Manejo de roles: `user` y `admin`.

---

## 10. New Relic (Infra + APM + Dashboards)

### Funcionalidades
- Monitoreo de EC2 (Infra Agent).
- Monitoreo de API (APM Agent).
- Dashboard con trazas funcionales completas.
- Alarmas de disponibilidad.

---

## 11. CI/CD Pipeline

### Frontend CI/CD
- Build + lint.  
- Lighthouse performance.  
- Deploy a S3.  
- Invalidación de CloudFront.

### Backend CI/CD
- Linter + tests unitarios.  
- Build Docker → ECR.  
- Deploy via CodeDeploy.  
- Semantic versioning.

### Serverless CI/CD
- Deploy automático de la Lambda.

---


## 13. Flujos Principales

### A. Flujo de Compra 
1. Usuario inicia compra.  
2. API obtiene token WebPay.  
3. Usuario paga.  
4. API publica solicitud al broker.  
5. Recibe validación vía broker.  
6. Generación de boleta (Lambda → S3).  
7. Envío de correo (SES).  
8. Creación de job para recomendaciones.  
9. Workers responden recomendaciones.  
10. WebSockets notifican al usuario.  

---

### B. Subastas e Intercambios (E3)
1. Admin publica oferta en broker.  
2. Otros grupos reciben.  
3. Envían propuestas, aceptan o rechazan.  
4. API actualiza BD.  
5. WebSockets notifican cambios en tiempo real.  

---
