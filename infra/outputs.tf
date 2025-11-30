output "vpc_id" {
  value = module.vpc.vpc_id
}

output "public_subnet_id" {
  value = module.vpc.public_subnet_id
}

output "ec2_backend_instance_id" {
  value = module.ec2-backend.instance_id
}

output "api_gateway_id" {
  value = module.api_gateway.rest_api_id
}
