terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.92"
    }
  }
}

# Recursos en la cuenta externa de Yampai

# Instancia EC2 importada desde la cuenta externa
resource "aws_instance" "worker_i_03d284aaa415f72b7" {
  provider = aws

  # Valores tomados desde la instancia existente (aws ec2 describe-instances)
  ami                    = "ami-0bbdd8c17ed981ef9"
  instance_type          = "t3.micro"
  subnet_id              = "subnet-04c579873589772e2"
  vpc_security_group_ids = ["sg-0f907fed5df476eb0"]

  lifecycle {
    ignore_changes = [
      tags,
    ]
  }
}


# Bucket S3 de boletas
resource "aws_s3_bucket" "boletas" {
  provider = aws
  bucket   = var.boletas_bucket_name

  lifecycle {
    ignore_changes = [
      tags,
    ]
  }
}
