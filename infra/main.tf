provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

# Provider para la otra cuenta (usar el profile configurado: yampai_aws)
provider "aws" {
  alias   = "yampai"
  region  = var.yampai_aws_region
  profile = var.yampai_aws_profile
}


###############################
# 1. MÓDULO DE VPC (USANDO TUS IDS REALES)
###############################
module "vpc" {
  source = "./modules/vpc"

  # NO crea nueva VPC → usa la tuya
  existing_vpc_id           = "vpc-020f47c26de1a5779"
  existing_public_subnet_id = "subnet-0e306dd668dc09f68"

  # No se usan cuando ya existe, pero deben estar definidos
  vpc_cidr = "172.31.0.0/16"
  env      = var.env
}

###############################
# 2. EC2 BACKEND EN LA SUBNET EXISTENTE
###############################
module "ec2-backend" {
  source = "./modules/ec2-backend"

  ami_id             = "ami-0cfde0ea8edd312d4"
  instance_type      = "t3.micro"
  key_name           = ""
  vpc_id             = module.vpc.vpc_id
  subnet_id          = module.vpc.public_subnet_id
  security_group_ids = []
  env                = var.env

  tags = {
    Project = "Backend"
    Env     = var.env
  }
}

###############################
# 3. API GATEWAY (OPCIONAL)
###############################
module "api_gateway" {
  source     = "./modules/api_gateway"
  name       = "api-${var.env}"
  aws_region = var.aws_region
  stage_name = var.env
  env        = var.env
}

###############################
# 4. MÓDULO: RECURSOS EN OTRA CUENTA (EC2 workers + S3 boletas)
###############################
module "external_services" {
  source = "./modules/yampai_services"
  providers = {
    aws = aws.yampai
  }

  env                 = var.env
  boletas_bucket_name = "boletas-boletas-dev-504956989578-us-east-1"
}
