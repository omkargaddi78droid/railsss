# Ten identical Ubuntu hosts with Docker in one cluster placement group. Roles (worker, api, nginx,
# redis, monitoring) are assigned later by deploy/inventory.json, so this file never changes
# between experiments.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az = coalesce(var.availability_zone, data.aws_availability_zones.available.names[0])
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_caller_identity" "me" {}

# --- network: one VPC, one public subnet ---

resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.40.1.0/24"
  availability_zone       = local.az
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# --- security: everything inside the VPC; the outside sees only what each party needs ---

resource "aws_security_group" "node" {
  name        = "${var.name}-node"
  description = "Scaling study hosts"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "all traffic between study hosts"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }
  ingress {
    description = "SSH from the admin"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "Grafana from the admin"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "gateway (nginx) from the k6 instance"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.k6_cidr]
  }
  ingress {
    description = "Prometheus remote write from the k6 instance"
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = [var.k6_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${var.name}-node" }
}

# --- images: ECR, pulled by the hosts through their instance role ---

resource "aws_ecr_repository" "image" {
  for_each             = toset(["engine", "api"])
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # terraform destroy removes the images too
}

resource "aws_iam_role" "node" {
  name = "${var.name}-node"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_instance_profile" "node" {
  name = "${var.name}-node"
  role = aws_iam_role.node.name
}

# --- hosts ---

resource "aws_key_pair" "admin" {
  key_name   = var.name
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_placement_group" "cluster" {
  name     = var.name
  strategy = "cluster"
}

locals {
  registry = "${data.aws_caller_identity.me.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

resource "aws_instance" "node" {
  count                  = var.instance_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.node.id]
  key_name               = aws_key_pair.admin.key_name
  placement_group        = aws_placement_group.cluster.id
  iam_instance_profile   = aws_iam_instance_profile.node.name
  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    registry = local.registry
    hostname = format("node%02d", count.index + 1)
  })
  user_data_replace_on_change = true

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # containers (ECR credential helper runs on the host, but keep it reachable)
  }

  tags = { Name = format("%s-node%02d", var.name, count.index + 1) }
}
