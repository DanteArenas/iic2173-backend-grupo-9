# 2025-2 / IIC2173 - E0 | Properties Market Async

***Fecha de entrega:** 01/09/2025 - 3 Semanas*

## Consideraciones generales:

Se implementaron todos los requisitos, funcionales y variables. Para el servicio web se utilizó Javascript con Koa, y Postgres para la base de datos con las propiedades. Para la conexión al broker se utilizó Javascript. 

La configuración de nginx, ubicada en la instancia ec2 en `/etc/nginx/sites-available/e0arquisisdantearenas.me`, se encuentra subida en el directorio raíz del repositorio.

## Nombre del dominio: e0arquisisdantearenas.me

Link de la API:
https://www.e0arquisisdantearenas.me/properties

IP elástica asociada:
54.174.177.30

## Método de acceso al servidor:

Ejecutar:
`ssh -i "e0arquisis.pem" ubuntu@ec2-54-174-177-30.compute-1.amazonaws.com`
en la carpeta en la que se encuentre el archivo .pem

## Puntajes logrados:

Se implementaron todos los requisitos y ambas partes variables:

### Requisitos funcionales (10p)

* **RF1: (3p) ✅** ***Esencial*** Debe poder ofrecer en una **API** la lista de las distintas propiedades que se han encontrado en el broker a medida que se vayan recibiendo junto con su cantidad de reservas de visitas disponibles, de forma que muestren el detalle y cuando fue su última actualización. Asuman que es solo una reserva de visita disponible por cada vez que les llega la propiedad. Esta lista debe ser accedida a través de HTTP en la URI: *`{url}/properties`*. Esta vista general puede mostrar solo los detalles más importantes de la propiedad.
* **RF2: (1p) ✅** ***Esencial*** Debe ofrecer un endpoint para mostrar el detalle  de cada propiedad recibida desde el broker con todas sus reservas de visitas. La URI debe ser: *`{url}/properties/{:id}`*
* **RF3: (2p) ✅** ***Esencial*** La lista de propiedades debe estar paginada por default para que muestre cada 25 viviendas y poder cambiar de pagina cambiando un *queryParam*. Es decir: *`{url}/properties?page=2&limit=25`*. Queda a criterio de ustedes si permiten traer más valores mediante otro número del `limit` en *queryParams*.
* **RF4: (4p) ✅*Esencial*** El endpoint *`{url}/properties`* debe permitir filtrar las propiedades por precio menor al indicado, comuna y fecha de publicación (exacta): *`{url}/properties?price=1000&location=maipu&date=2025-08-08`*. Acá *date* es la fecha de publicación según el campo `timestamp` que recibirían y *location* debe permitir búsquedas parciales, es decir que si la dirección es *ABC 123, Maipú, RM*, el buscar solo *maipu* debería obtenerla.
    
*Comentarios:*
* Al filtrar por precio se filtran las propiedades estrictamente menores al parámetro, no menores o iguales
* Se agregó el parámetro `currency` para complementar al precio, puede tomar los valores `$` para filtrar por precio en las propiedades que estén en pesos chilenos y `uf` si se quiere filtrar por precio para las propiedades en UF. Si se filtra por precio sin entregar este parámetro se filtrará predeterminadamente por pesos chilenos. No se hace la conversión de pesos chilenos a UF ni viceversa, solamente se filtra según el campo `currency` recibido del broker. El parámetro`currency` solo hace efecto al filtrar por precio.

### Requisitos no funcionales (20p)

* **RNF1: (5p ✅)** ***Esencial*** Debe poder conectarse al broker mediante el protocolo MQTT usando un proceso que corra de **forma constante e independiente de la aplicación web** (que corra como otro programa), los eventos recibidos deben ser persistidos con su sistema para que estos puedan ser mostrados (existen diferentes opciones). Para esto debe usar las credenciales dentro del repositorio y conectarse al canal **properties/info**.
* **RNF2: (3p) ✅** Debe haber un proxy inverso apuntando a su aplicación web (como Nginx o Traefik). *Todo lo que es Nginx es mejor configurarlo directamente en la instancia EC2 y no necesariamente con Docker.*
* **RNF3: (2p) ✅** El servidor debe tener un nombre de dominio de primer nivel (tech, me, tk, ml, ga, com, cl, etc)
* **RNF4: (2p) ✅** ***Esencial*** El servidor debe estar corriendo en EC2.
* **RNF5: (4p) ✅** Debe haber una base de datos Postgres o Mongo externa asociada a la aplicación para guardar eventos y consultarlos.
* **RNF6: (4p) ✅** ***Esencial*** El servicio (API Web) debe estar dentro de un container Docker.

#### Docker-Compose (15p)

Componer servicios es esencial para obtener entornos de prueba confiables, especialmente en las máquinas de los desarrolladores. Además, esta herramienta será necesaria durante el resto del desarrollo del proyecto para orquestar sus contenedores y servicios.

* **RNF1: (5p) ✅** Lanzar su app web desde docker compose
* **RNF2: (5p) ✅** Integrar su DB desde docker compose (Es decir la base de datos es un contenedor).
* **RNF3: (5p) ✅** Lanzar su receptor MQTT desde docker compose y conectarlo al contenedor de la app web (o base de datos si lo usara).

## Variable
    
Se implementaron los dos grupos de requisitos.
    
#### HTTPS (25%) (15p)

* **RNF1: (7p) ✅** El dominio debe estar asegurado por SSL con Let’s Encrypt.
* **RNF2: (3p) ✅** Debe poder redireccionar HTTP a HTTPS.
* **RNF3: (5p) ✅** Se debe ejecutar el chequeo de expiración del certificado SSL de forma automática 2 veces al día (solo se actualiza realmente si está llegando a la fecha de expiración).

#### Balanceo de Carga con Nginx (25%) (15p)

* **RF1: (5p) ✅** Debe replicar al menos 2 contenedores de su aplicación web para que corran en paralelo.
* **RF2: (10p) ✅** Debe configurar Nginx para que haga un balanceo de carga hacia los servidores levantados (Pueden encontrar la configuración en la documentación de NGINX).
