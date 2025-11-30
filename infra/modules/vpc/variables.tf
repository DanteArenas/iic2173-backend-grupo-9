variable "env" {
  description = "Environment name (e.g., dev, prod)"
  type        = string
  default     = "dev"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC (only required when creating a new VPC)"
  type        = string
  default     = null
}

variable "existing_vpc_id" {
  description = "ID of an existing VPC. If set, the module will use it instead of creating a new VPC."
  type        = string
  default     = ""
}

variable "existing_public_subnet_id" {
  description = "ID of an existing public subnet. If set, the module will use it instead of creating a new subnet."
  type        = string
  default     = ""
}
