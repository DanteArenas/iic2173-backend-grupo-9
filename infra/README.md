# Infra (Terraform)

Descripción
-----------
Este directorio contiene la configuración de Terraform utilizada para desplegar y gestionar la infraestructura del proyecto: VPC, instancias EC2, API Gateway, Lambdas y recursos auxiliares. Aquí se documenta qué gestiona Terraform, variables importantes, cómo inicializar y cómo importar recursos existentes.
# Infra (Terraform)

Descripción
-----------
Este directorio contiene la configuración de Terraform utilizada para desplegar y gestionar la infraestructura del proyecto: VPC, instancias EC2, API Gateway, Lambdas y recursos auxiliares. El README describe qué gestiona Terraform, las variables más relevantes, outputs, flujo de importación de recursos existentes y buenas prácticas.

Resumen de lo que gestiona Terraform
-----------------------------------
- Provider AWS configurado en `infra/main.tf` (región y perfil).
- `modules/vpc`: puede usar una VPC y subnet existentes (parámetros `existing_vpc_id` y `existing_public_subnet_id`) o crear una VPC/subnet nuevas cuando esos valores están vacíos.
- `modules/ec2-backend`: instancia EC2 que actúa como backend HTTP (AMI, tipo, subnet, security group). En esta rama se referencian IDs concretos.
- `modules/api_gateway`: API Gateway REST que define recursos, métodos, integraciones y CORS:
  - Rutas: `/payments`, `/payments/webpay`, `/payments/webpay/return`, `/{proxy+}`.
  - Métodos: GET/POST/ANY para rutas; `OPTIONS` para CORS.
  - Integraciones: `HTTP_PROXY` apuntando a la EC2 para rutas principales; `MOCK` para respuestas de CORS.
  - Deployment y Stage (`aws_api_gateway_deployment` y `aws_api_gateway_stage`).

Archivos principales
--------------------
- `infra/main.tf`: provider y llamadas a módulos (`vpc`, `ec2-backend`, `api_gateway`).
- `infra/variables.tf`: variables globales (p. ej. `aws_region`, `aws_profile`, `env`).
- `infra/outputs.tf`: outputs públicos (IDs y URL del API).
- `infra/terraform.tf`: bloque `terraform` con requisitos de proveedores.

Variables importantes
---------------------
- `aws_region` (string, default `us-east-1`): región AWS.
- `aws_profile` (string, default `terraform`): perfil AWS CLI opcional.
- `env` (string, default `dev`): nombre del entorno; se utiliza para nombres, tags y `stage_name` del API Gateway.
- `existing_vpc_id`, `existing_public_subnet_id`: permiten reutilizar infraestructura ya existente.

Outputs
-------
- `vpc_id`, `public_subnet_id`: desde `modules/vpc`.
- `ec2_backend_instance_id`: id de la instancia EC2 creada (o referenciada).
- `api_gateway_id` / `invoke_url`: id y URL base del API Gateway.

Importación de recursos existentes (API Gateway)
---------------------------------------------
Flujo recomendado para no recrear recursos ya existentes en AWS:

1. Añadir los bloques `resource` necesarios en HCL (ya están en `modules/api_gateway`).
2. Importar en este orden: REST API → recursos → métodos → integraciones → method_response/integration_response → deployment → stage.

Ejemplos (reemplazar `<...>` con los ids reales):

```bash
terraform import module.api_gateway.aws_api_gateway_rest_api.this <rest_api_id>
terraform import module.api_gateway.aws_api_gateway_resource.payments      <rest_api_id>/<payments_resource_id>
terraform import module.api_gateway.aws_api_gateway_resource.webpay        <rest_api_id>/<webpay_resource_id>
terraform import module.api_gateway.aws_api_gateway_resource.webpay_return <rest_api_id>/<webpay_return_resource_id>
terraform import module.api_gateway.aws_api_gateway_resource.proxy        <rest_api_id>/<proxy_resource_id>
terraform import module.api_gateway.aws_api_gateway_method.webpay_return_get  <rest_api_id>/<webpay_return_resource_id>/GET
terraform import module.api_gateway.aws_api_gateway_method.webpay_return_post <rest_api_id>/<webpay_return_resource_id>/POST
terraform import module.api_gateway.aws_api_gateway_method.proxy_any         <rest_api_id>/<proxy_resource_id>/ANY
terraform import module.api_gateway.aws_api_gateway_integration.webpay_return_post  <rest_api_id>/<webpay_return_resource_id>/POST
terraform import module.api_gateway.aws_api_gateway_integration.proxy_any          <rest_api_id>/<proxy_resource_id>/ANY
terraform import module.api_gateway.aws_api_gateway_deployment.this <rest_api_id>/<deployment_id>
terraform import module.api_gateway.aws_api_gateway_stage.prod <rest_api_id>/<stage_name>
```

Notas:
- Ejecutar `terraform plan` tras cada import y ajustar HCL si hay diferencias.
- Para listar deployments/stages puede usar:

```bash
aws apigateway get-deployments --rest-api-id <rest_api_id> --region <region>
aws apigateway get-stages --rest-api-id <rest_api_id> --region <region>
```

Buenas prácticas
-----------------
- Usar backend remoto (S3 + DynamoDB) para el estado cuando trabaja en equipo.
- No subir secretos ni `*.tfstate` al repositorio.
- Commitear `.terraform.lock.hcl` para fijar versiones de proveedores.
- Mantener `terraform.tfvars` fuera del repo y añadir `terraform.tfvars.example` con valores de ejemplo.

Comandos de uso rápido
----------------------
Inicializar y validar:

```bash
cd infra
terraform init
terraform validate
```

Plan / Apply (con variable `env` opcional):

```bash
terraform plan -var="env=<env>"
terraform apply -var="env=<env>"
```

Usando archivos de variables:

```bash
terraform plan -var-file=dev.tfvars
terraform apply -var-file=dev.tfvars
```

Notas finales
-------------
- El valor por defecto `env = "dev"` es un ejemplo y se usa en `main.tf` para `stage_name` del API Gateway. Cámbielo a `prod` u otro entorno según su flujo de trabajo.

**Yampai Services**

- **Propósito**: Este módulo (`modules/yampai_services`) gestiona recursos que residen en la cuenta de Yampai. Actualmente contiene recursos importados (instancia EC2 de los workers worker) y un bucket S3 que almacena boletas.
- **Proveedor / Cuenta**: El módulo se aplica usando un provider alias (`provider "aws" { alias = "yampai" ... }`) y en `infra/main.tf` se mapea ese provider al módulo con `providers = { aws = aws.yampai }`. Esto permite gestionar recursos en otra cuenta sin cambiar el provider global.

**Recursos principales**
- **Instancia EC2**: Recurso `aws_instance` definidos en el módulo (`aws_instance.worker_i_03d284aaa415f72b7`) que representan workers ya existentes en la cuenta externa. Sus atributos esenciales (AMI, type, subnet, security group) están fijados según la instancia importada.
- **Bucket S3 de boletas**: Recurso `aws_s3_bucket.boletas` cuyo nombre se toma desde la variable `boletas_bucket_name`.

**Variables importantes**
- `boletas_bucket_name` (string): Nombre del bucket S3 en la cuenta externa.
- `worker_ids` (list(string)): Lista con los IDs de instancias EC2 que se pueden importar (opcional, se usa para documentar/esperar los IDs).
- `env` (string): Nombre del entorno (ej. `dev`, `prod`).

**Outputs**
- `worker_ids`: (passthrough) lista de IDs definida por la variable `worker_ids`.
- `boletas_bucket_name`: nombre del bucket S3 expuesto por el módulo.

**Flujo IaC y pasos para usar el módulo `yampai_services`**

1. Configurar provider alias para la cuenta externa en `infra/main.tf` (ya existe un provider `aws` con `alias = "yampai"`).
2. En la invocación del módulo, mapear el provider: `providers = { aws = aws.yampai }`.
3. Ajustar variables del módulo en `infra/main.tf` (por ejemplo: `boletas_bucket_name`, `env`).
4. Inicializar Terraform en el directorio `infra`:

```bash
cd infra
terraform init
```

5. (Recomendado) Revisar con `terraform plan -var="env=<env>"` para validar que la configuración HCL refleja la infraestructura esperada.

6. Importar recursos existentes desde la cuenta externa a la configuración de Terraform (ejemplos):

- Importar una instancia EC2 en el módulo. Reemplace `<instance_id>` por el ID real y ajuste el nombre del recurso si fuera distinto:

```bash
terraform import 'module.external_services.aws_instance.worker_i_03d284aaa415f72b7' <instance_id> --provider=aws.yampai
```

- Importar el bucket S3 (usar el nombre real del bucket):

```bash
terraform import 'module.external_services.aws_s3_bucket.boletas' <boletas_bucket_name> --provider=aws.yampai
```

Notas sobre import:
- Use el flag `--provider=aws.yampai` para señalar que el recurso reside en la cuenta externa manejada por el provider alias.
- Tras cada import, ejecute `terraform plan` y ajuste la HCL si Terraform detecta diferencias en atributos gestionados.

**Consideraciones operativas**
- Los recursos importados en el módulo usan un bloque `lifecycle { ignore_changes = [tags] }` para evitar sobrescribir etiquetas que puedan cambiar fuera de Terraform; ajuste según sus políticas.
- Se recomienda mantener un `terraform.tfstate` remoto (S3 + DynamoDB lock) por equipo y por cada cuenta/entorno para evitar corrupciones de estado.
- Documente en un archivo `terraform.tfvars` (fuera del repositorio) los valores sensibles/propios de cada cuenta (por ejemplo, `boletas_bucket_name`).

**Ejemplo rápido de verificación**

1. `terraform init`
2. `terraform plan -var="env=dev"`
3. Si necesita traer recursos existentes: ejecutar los `terraform import` anteriores especificando `--provider=aws.yampai`.


