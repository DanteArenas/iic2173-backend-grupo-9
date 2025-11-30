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
- Puedo generar `terraform.tfvars.example` y/o ajustar el README con ejemplos por entorno si lo desea.
