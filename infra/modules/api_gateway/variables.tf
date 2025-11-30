variable "name" {
  description = "API Gateway name"
  type        = string
}

variable "aws_region" {
  description = "AWS region for building integration URI"
  type        = string
  default     = "us-east-2"
}

variable "stage_name" {
  description = "Stage name for deployment"
  type        = string
  default     = "dev"
}

variable "env" {
  description = "Environment name"
  type        = string
  default     = "dev"
}
