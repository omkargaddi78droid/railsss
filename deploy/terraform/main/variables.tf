variable "name" {
  description = "Prefix for every resource name and tag."
  type        = string
  default     = "railway-scaling"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "aws_profile" {
  description = "AWS CLI profile of the main account (null = default credential chain)."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "Study budget: m6i.large or m7i.large only (2 vCPU = 1 physical core with HT, 8 GB)."
  type        = string
  default     = "m6i.large"

  validation {
    condition     = contains(["m6i.large", "m7i.large"], var.instance_type)
    error_message = "The study is fixed to m6i.large or m7i.large."
  }
}

variable "instance_count" {
  description = "Never more than 10 (study budget)."
  type        = number
  default     = 10

  validation {
    condition     = var.instance_count >= 1 && var.instance_count <= 10
    error_message = "instance_count must be between 1 and 10."
  }
}

variable "availability_zone" {
  description = "One AZ for everything (cluster placement group). null = the region's first AZ."
  type        = string
  default     = null
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "admin_cidr" {
  description = "Your IP as a /32: SSH and Grafana are open to it only."
  type        = string
}

variable "k6_cidr" {
  description = "Public IP of the k6 instance (other account) as a /32: nginx :80 and Prometheus remote write :9090."
  type        = string
}

variable "root_volume_gb" {
  type    = number
  default = 30
}
