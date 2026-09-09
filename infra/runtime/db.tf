locals {
  db_config = merge(var.db, {
    region    = local.region
    volume_id = aws_ebs_volume.db_data.id
    app_cidrs = [aws_subnet.main["app_a"].cidr_block, aws_subnet.main["app_c"].cidr_block]
    packages  = local.db_packages
  })
  db_files = [
    { path = "/etc/logstack-db.json", permissions = "0600", owner = "root:root", content = jsonencode(local.db_config) },
    { path = "/usr/local/lib/logstack/db-bootstrap.sh", permissions = "0700", owner = "root:root", content = file("${path.module}/templates/db-bootstrap.sh") },
    { path = "/usr/local/lib/logstack/db-admin.py", permissions = "0700", owner = "root:root", content = file("${path.module}/templates/db-admin.py") },
    { path = "/usr/local/lib/logstack/db-install.sh", permissions = "0700", owner = "root:root", content = file("${path.module}/templates/db-install.sh") },
    { path = "/etc/yum.repos.d/logstack-approved.repo", permissions = "0644", owner = "root:root", content = templatefile("${path.module}/templates/db-repository.repo.tftpl", { repository_url = local.db_repository_url }) },
    { path = "/etc/systemd/system/logstack-db-install.service", permissions = "0644", owner = "root:root", content = file("${path.module}/templates/db-install.service") },
    { path = "/usr/local/lib/logstack/db-backup.py", permissions = "0700", owner = "root:root", content = file("${path.module}/templates/db-backup.py") },
    { path = "/etc/logstack-backup.json", permissions = "0600", owner = "root:root", content = jsonencode(local.db_backup_config) },
    { path = "/etc/systemd/system/logstack-db-backup.service", permissions = "0644", owner = "root:root", content = file("${path.module}/templates/db-backup.service") },
    { path = "/etc/systemd/system/logstack-db-backup.timer", permissions = "0644", owner = "root:root", content = file("${path.module}/templates/db-backup.timer") },
    { path = "/etc/systemd/system/logstack-db-prepare.service", permissions = "0644", owner = "root:root", content = templatefile("${path.module}/templates/db-prepare.service.tftpl", { ssm_service = var.db.ssm_service, chrony_service = var.db.chrony_service }) },
    { path = "/etc/systemd/system/logstack-postgresql.service", permissions = "0644", owner = "root:root", content = templatefile("${path.module}/templates/db-postgresql.service.tftpl", { pg_bin = var.db.pg_bin }) }
  ]
  db_user_data = templatefile("${path.module}/templates/db-cloud-config.tftpl", { files = local.db_files })
}

data "aws_ami" "db" {
  owners = [var.db.ami_owner]
  filter {
    name   = "image-id"
    values = [var.db.ami_id]
  }
  filter {
    name   = "architecture"
    values = [var.db.architecture]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

data "aws_ec2_instance_type" "db" {
  instance_type = var.db.instance_type
}

resource "aws_ebs_volume" "db_data" {
  availability_zone = aws_subnet.main[var.db.subnet_key].availability_zone
  type              = "gp3"
  size              = var.db.data_gib
  iops              = var.db.data_iops
  throughput        = var.db.data_throughput_mibps
  encrypted         = true
  kms_key_id        = var.db.ebs_kms_key_arn
  tags              = { Name = "${local.name}-db-data", DataRole = "postgresql-16", Retention = "human-review-required", BackupPolicy = local.db_snapshot_policy }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "db" {
  ami                         = data.aws_ami.db.id
  instance_type               = var.db.instance_type
  subnet_id                   = aws_subnet.main[var.db.subnet_key].id
  vpc_security_group_ids      = [aws_security_group.main["db"].id]
  iam_instance_profile        = aws_iam_instance_profile.ec2["db"].name
  associate_public_ip_address = false
  user_data_base64            = base64gzip(local.db_user_data)
  user_data_replace_on_change = true
  depends_on = [
    aws_iam_role_policy.db_parameters, aws_iam_role_policy.db_backup,
    aws_vpc_endpoint.interface, aws_vpc_endpoint.s3,
    aws_s3_bucket_policy.db_backup, aws_s3_bucket_lifecycle_configuration.db_backup
    , aws_dlm_lifecycle_policy.db_data
  ]
  monitoring = false
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  credit_specification { cpu_credits = var.db.cpu_credits }
  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.db.root_gib
    iops                  = var.db.root_iops
    throughput            = var.db.root_throughput_mibps
    encrypted             = true
    kms_key_id            = var.db.ebs_kms_key_arn
    delete_on_termination = true
    tags                  = { Name = "${local.name}-db-root", Project = var.project, Environment = var.environment }
  }
  tags = { Name = "${local.name}-db", AL2023Release = var.db.al2023_release }
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.db.al2023_release == local.db_al2023_release && var.db.instance_type == "t3.medium" && var.db.subnet_key == "data_a" && var.db.cpu_credits == "standard" && var.db.root_gib == 20 && var.db.data_gib == 100 && var.db.root_iops == 3000 && var.db.data_iops == 3000 && var.db.root_throughput_mibps == 125 && var.db.data_throughput_mibps == 125 && var.db.database == "gamelogs" && var.db.application_role == "logstack_app" && var.db.migration_role == "logstack_migrator" && var.db.pg_bin == "/usr/bin" && var.db.ssm_service == "amazon-ssm-agent.service" && var.db.chrony_service == "chronyd.service" && var.db.ebs_kms_key_arn == "arn:aws:kms:ap-northeast-2:324037288068:key/f6ed82b3-880c-46c9-a2fc-d5e77e71e80c"
      error_message = "Inputs must match the human-approved T5 DB/storage/role/AL2023 contract. Changing it requires a new review."
    }
    precondition {
      condition     = contains(data.aws_ec2_instance_type.db.supported_architectures, var.db.architecture) && data.aws_ami.db.virtualization_type == "hvm"
      error_message = "Pinned AMI architecture/virtualization is incompatible with the selected EC2 type."
    }
    precondition {
      condition     = length(base64gzip(local.db_user_data)) <= 21844
      error_message = "Compressed EC2 user_data must fit below the 16 KiB raw API limit."
    }
  }
}

resource "aws_volume_attachment" "db_data" {
  device_name  = "/dev/sdf"
  volume_id    = aws_ebs_volume.db_data.id
  instance_id  = aws_instance.db.id
  force_detach = false
  lifecycle {
    prevent_destroy = true
  }
}

output "database_infrastructure" {
  description = "Non-secret T6 handoff only; not evidence of bootstrap/readiness."
  value = {
    instance_id    = aws_instance.db.id, private_ip = aws_instance.db.private_ip,
    volume_id      = aws_ebs_volume.db_data.id, availability_zone = aws_ebs_volume.db_data.availability_zone,
    database       = var.db.database, migration_role = var.db.migration_role, application_role = var.db.application_role,
    parameter_arns = [var.db.migration_secret_arn, var.db.application_secret_arn],
    backup_status  = "Configured daily S3 dump + DLM snapshots; execution/restore NOT_VERIFIED"
  }
}
