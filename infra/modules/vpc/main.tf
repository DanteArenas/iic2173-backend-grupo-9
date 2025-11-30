locals {
  using_existing_vpc    = var.existing_vpc_id != ""
  using_existing_subnet = var.existing_public_subnet_id != ""
}

# --------------------
# USE EXISTING RESOURCES
# --------------------

data "aws_vpc" "existing" {
  count = local.using_existing_vpc ? 1 : 0
  id    = var.existing_vpc_id
}

data "aws_subnet" "public_existing" {
  count = local.using_existing_subnet ? 1 : 0
  id    = var.existing_public_subnet_id
}

# --------------------
# CREATE NEW VPC
# --------------------

resource "aws_vpc" "this" {
  count      = local.using_existing_vpc ? 0 : 1
  cidr_block = var.vpc_cidr
  tags = {
    Name = "vpc-${var.env}"
  }
}

resource "aws_subnet" "public" {
  count                   = local.using_existing_subnet ? 0 : 1
  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  map_public_ip_on_launch = true
  tags = {
    Name = "public-subnet-${var.env}"
  }
}

resource "aws_internet_gateway" "igw" {
  count  = local.using_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.this[0].id
}

resource "aws_route_table" "public" {
  count  = local.using_existing_vpc ? 0 : 1
  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw[0].id
  }
}

resource "aws_route_table_association" "public_assoc" {
  count          = local.using_existing_subnet ? 0 : 1
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}
