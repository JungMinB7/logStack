output "vpc" {
  value = { id = aws_vpc.main.id, cidr = aws_vpc.main.cidr_block }
}

output "subnets" {
  value = { for name, subnet in aws_subnet.main : name => {
    id = subnet.id, az = subnet.availability_zone, cidr = subnet.cidr_block
  } }
}

output "route_table_ids" {
  value = { for name, rt in aws_route_table.main : name => rt.id }
}

output "gateways" {
  value = { igw_id = aws_internet_gateway.main.id, nat_id = aws_nat_gateway.main.id, eip_allocation_id = aws_eip.nat.id }
}

output "security_group_ids" {
  value = { for name, sg in aws_security_group.main : name => sg.id }
}

output "endpoints" {
  value = {
    interface_ids     = { for name, endpoint in aws_vpc_endpoint.interface : name => endpoint.id }
    s3_id             = aws_vpc_endpoint.s3.id
    s3_prefix_list_id = aws_vpc_endpoint.s3.prefix_list_id
  }
}

output "instance_management" {
  value = { for name, role in aws_iam_role.ec2 : name => {
    role_arn = role.arn, instance_profile_name = aws_iam_instance_profile.ec2[name].name
    instance_profile_arn = aws_iam_instance_profile.ec2[name].arn
  } }
}
