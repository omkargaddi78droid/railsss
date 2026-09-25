output "region" {
  value = var.region
}

output "instance_type" {
  value = var.instance_type
}

output "registry" {
  value = local.registry
}

output "repositories" {
  value = { for k, r in aws_ecr_repository.image : k => r.repository_url }
}

output "nodes" {
  description = "Feeds deploy/inventory.ts."
  value = [for i in aws_instance.node : {
    name       = trimprefix(i.tags.Name, "${var.name}-")
    id         = i.id
    public_ip  = i.public_ip
    private_ip = i.private_ip
  }]
}
