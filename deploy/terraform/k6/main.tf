# The load generator: one instance in a SECOND AWS account, so k6 never shares the study's
# account limits or network with the system under test. Apply this first; its public IP is
# the main stack's k6_cidr.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = { Project = "${var.name}-k6" }
  }
}

variable "name" {
  type    = string
  default = "railway-scaling"
}

variable "region" {
  description = "Same region as the main stack, so the measured latency is not cross-region."
  type        = string
  default     = "ap-south-1"
}

variable "aws_profile" {
  description = "AWS CLI profile of the k6 (second) account."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "Not part of the 10-instance budget; 4 vCPU is plenty for a few hundred req/s."
  type        = string
  default     = "c6i.xlarge"
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "admin_cidr" {
  description = "Your IP as a /32 (SSH only)."
  type        = string
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_vpc" "k6" {
  cidr_block = "10.50.0.0/16"
  tags       = { Name = "${var.name}-k6" }
}

resource "aws_internet_gateway" "k6" {
  vpc_id = aws_vpc.k6.id
}

resource "aws_subnet" "k6" {
  vpc_id                  = aws_vpc.k6.id
  cidr_block              = "10.50.1.0/24"
  map_public_ip_on_launch = true
}

resource "aws_route_table" "k6" {
  vpc_id = aws_vpc.k6.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.k6.id
  }
}

resource "aws_route_table_association" "k6" {
  subnet_id      = aws_subnet.k6.id
  route_table_id = aws_route_table.k6.id
}

resource "aws_security_group" "k6" {
  name   = "${var.name}-k6"
  vpc_id = aws_vpc.k6.id
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_key_pair" "admin" {
  key_name   = "${var.name}-k6"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_eip" "k6" {
  domain   = "vpc"
  instance = aws_instance.k6.id # stable IP: the main stack's security group allows only this address
}

resource "aws_instance" "k6" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.k6.id
  vpc_security_group_ids = [aws_security_group.k6.id]
  key_name               = aws_key_pair.admin.key_name
  user_data              = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends docker.io rsync jq
    usermod -aG docker ubuntu
    printf 'net.ipv4.ip_local_port_range = 10240 65535\nnet.ipv4.tcp_tw_reuse = 1\n' > /etc/sysctl.d/90-loadtest.conf
    sysctl --system
    docker pull grafana/k6:latest
    mkdir -p /opt/loadtest && chown ubuntu:ubuntu /opt/loadtest
    touch /var/lib/railway-ready
  EOT
  root_block_device {
    volume_type = "gp3"
    volume_size = 20
  }
  metadata_options {
    http_tokens = "required"
  }
  tags = { Name = "${var.name}-k6" }
}

output "public_ip" {
  value = aws_eip.k6.public_ip
}

output "k6_cidr" {
  value = "${aws_eip.k6.public_ip}/32"
}
