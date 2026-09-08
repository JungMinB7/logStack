locals {
  role_arns = [for role in aws_iam_role.ec2 : role.arn]
  deny_all = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Deny", Principal = "*", Action = "*", Resource = "*" }]
  })
  interface_policies = {
    ssm = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect = "Allow", Principal = "*", Action = local.ssm_actions, Resource = "*"
        Condition = { ArnEquals = { "aws:PrincipalArn" = local.role_arns } }
      }]
    })
    ssmmessages = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect = "Allow", Principal = "*", Action = local.channel_actions, Resource = "*"
        Condition = { ArnEquals = { "aws:PrincipalArn" = local.role_arns } }
      }]
    })
    # Log groups/retention/role permissions are T5-T7 inputs; no wildcard Allow.
    logs = local.deny_all
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ssm", "ssmmessages", "logs"])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.main["app_a"].id, aws_subnet.main["app_c"].id]
  security_group_ids  = [aws_security_group.main["vpce"].id]
  private_dns_enabled = true
  policy              = local.interface_policies[each.key]
  tags                = { Name = "${local.name}-${each.key}" }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for name in ["app_a", "app_c", "data_a", "data_c"] : aws_route_table.main[name].id]
  policy = length(var.s3_read_paths) == 0 ? local.deny_all : jsonencode({
    Version = "2012-10-17"
    Statement = [for grant in values(var.s3_read_paths) : {
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = "arn:aws:s3:::${grant.bucket}/${grant.prefix}*"
      Condition = { ArnEquals = { "aws:PrincipalArn" = [for role in grant.roles : aws_iam_role.ec2[role].arn] } }
    }]
  })
  tags = { Name = "${local.name}-s3" }
}
