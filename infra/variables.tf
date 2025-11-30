variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-2"
}

variable "aws_profile" {
  description = "Named AWS CLI profile to use (optional)"
  type        = string
  default     = "terraform"
}

variable "env" {
  description = "Environment name (dev/staging/prod)"
  type        = string
  default     = "dev"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "yampai_aws_region" {
  description = "AWS region for the Yampai (external) account"
  type        = string
  default     = "us-east-1"
}

variable "yampai_aws_profile" {
  description = "Named AWS CLI profile to use for the Yampai (external) account"
  type        = string
  default     = "yampai_aws"
}
