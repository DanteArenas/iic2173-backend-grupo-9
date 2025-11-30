variable "ami_id" {
  description = "AMI ID to use for the instance"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "key_name" {
  description = "SSH key name (optional)"
  type        = string
  default     = ""
}

variable "vpc_id" {
  description = "VPC ID where the EC2 will be deployed"
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID for the EC2 instance"
  type        = string
}

variable "security_group_ids" {
  description = "List of security group IDs to attach"
  type        = list(string)
  default     = []
}

variable "env" {
  description = "Environment name (dev/staging/prod)"
  type        = string
}

variable "tags" {
  description = "Map of tags to apply"
  type        = map(string)
  default     = {}
}
