locals {
  ec2_roles = toset(["sender", "receiver", "db"])
  service_links = {
    sender_int   = { source = "sender", target = "int-alb", port = 443 }
    int_receiver = { source = "int-alb", target = "receiver", port = 3000 }
    ext_receiver = { source = "ext-alb", target = "receiver", port = 3000 }
    receiver_db  = { source = "receiver", target = "db", port = 5432 }
  }
  s3_roles = setunion(toset(["db"]), toset(flatten([for grant in values(var.s3_read_paths) : tolist(grant.roles)])))
}

resource "aws_security_group" "main" {
  for_each    = toset(["sender", "int-alb", "ext-alb", "receiver", "db", "vpce"])
  name        = "${local.name}-${each.key}"
  description = "T4 ${each.key}; standalone rules only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "service" {
  for_each                     = local.service_links
  security_group_id            = aws_security_group.main[each.value.target].id
  referenced_security_group_id = aws_security_group.main[each.value.source].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  tags                         = { Name = each.key }
}

resource "aws_vpc_security_group_egress_rule" "service" {
  for_each                     = local.service_links
  security_group_id            = aws_security_group.main[each.value.source].id
  referenced_security_group_id = aws_security_group.main[each.value.target].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  tags                         = { Name = each.key }
}

resource "aws_vpc_security_group_ingress_rule" "management" {
  for_each                     = local.ec2_roles
  security_group_id            = aws_security_group.main["vpce"].id
  referenced_security_group_id = aws_security_group.main[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  tags                         = { Name = "${each.key}-vpce" }
}

resource "aws_vpc_security_group_egress_rule" "management" {
  for_each                     = local.ec2_roles
  security_group_id            = aws_security_group.main[each.key].id
  referenced_security_group_id = aws_security_group.main["vpce"].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  tags                         = { Name = "${each.key}-vpce" }
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  for_each          = toset(["sender", "receiver"])
  security_group_id = aws_security_group.main[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = { Name = "${each.key}-nat-https" }
}

resource "aws_vpc_security_group_egress_rule" "s3" {
  for_each          = local.s3_roles
  security_group_id = aws_security_group.main[each.key].id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = { Name = "${each.key}-s3" }
}

# T4 ext-alb ingress is deliberately absent. T9 must supply approved CIDRs.
