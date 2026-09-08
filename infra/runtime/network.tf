locals {
  region = "ap-northeast-2"
  name   = "${var.project}-${var.environment}"
  subnets = {
    public_a = { cidr = "10.0.0.0/24", az = var.availability_zones.a, rt = "public" }
    public_c = { cidr = "10.0.1.0/24", az = var.availability_zones.c, rt = "public" }
    app_a    = { cidr = "10.0.10.0/24", az = var.availability_zones.a, rt = "app_a" }
    app_c    = { cidr = "10.0.11.0/24", az = var.availability_zones.c, rt = "app_c" }
    data_a   = { cidr = "10.0.20.0/24", az = var.availability_zones.a, rt = "data_a" }
    data_c   = { cidr = "10.0.21.0/24", az = var.availability_zones.c, rt = "data_c" }
  }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

# Clear AWS-created permissive defaults; service SG6 are separate resources.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-unused-default" }
}

resource "aws_subnet" "main" {
  for_each                = local.subnets
  vpc_id                  = aws_vpc.main.id
  cidr_block              = each.value.cidr
  availability_zone       = each.value.az
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-${each.key}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id     = aws_eip.nat.id
  subnet_id         = aws_subnet.main["public_a"].id
  connectivity_type = "public"
  depends_on        = [aws_internet_gateway.main]
  tags              = { Name = local.name }
}

resource "aws_route_table" "main" {
  for_each = toset(["public", "app_a", "app_c", "data_a", "data_c"])
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name}-${each.key}" }
}

resource "aws_route_table_association" "main" {
  for_each       = local.subnets
  subnet_id      = aws_subnet.main[each.key].id
  route_table_id = aws_route_table.main[each.value.rt].id
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.main["public"].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route" "app_default" {
  for_each               = toset(["app_a", "app_c"])
  route_table_id         = aws_route_table.main[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}
