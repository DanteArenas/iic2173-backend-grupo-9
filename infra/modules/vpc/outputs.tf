output "vpc_id" {
  value = length(data.aws_vpc.existing) > 0 ? data.aws_vpc.existing[0].id : aws_vpc.this[0].id
}

output "public_subnet_id" {
  value = length(data.aws_subnet.public_existing) > 0 ? data.aws_subnet.public_existing[0].id : aws_subnet.public[0].id
}
