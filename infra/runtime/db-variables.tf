variable "db" {
  description = "T5 required, non-secret inputs. No default AMI/type/storage or deployment opt-out. See ../T5_STATUS.md for pending approvals."
  nullable    = false
  type = object({
    ami_id                  = string
    ami_owner               = string
    architecture            = string
    al2023_release          = string
    instance_type           = string
    subnet_key              = string
    cpu_credits             = string
    root_gib                = number
    root_iops               = number
    root_throughput_mibps   = number
    data_gib                = number
    data_iops               = number
    data_throughput_mibps   = number
    ebs_kms_key_arn         = string
    allow_blank_volume_init = bool
    database                = string
    migration_role          = string
    application_role        = string
    migration_secret_arn    = string
    application_secret_arn  = string
    pg_bin                  = string
    ssm_service             = string
    chrony_service          = string
  })

  validation {
    condition     = var.db.ami_id == "ami-080417beadd39ca40" && var.db.ami_owner == "137112412989" && var.db.al2023_release == "2023.12.20260831" && var.db.architecture == "x86_64"
    error_message = "Use the reviewed official Seoul AL2023 AMI/owner/release/x86_64. Changing the pinned release requires repository/package review, not most_recent."
  }
  validation {
    condition     = contains(["data_a", "data_c"], var.db.subnet_key) && can(regex("^t3[a-z]*\\.[a-z0-9]+$", var.db.instance_type)) && contains(["standard", "unlimited"], var.db.cpu_credits)
    error_message = "Select an approved data subnet and T3-family type/credit policy; other families need review of this contract."
  }
  validation {
    condition     = alltrue([for disk in [{ size = var.db.root_gib, iops = var.db.root_iops, throughput = var.db.root_throughput_mibps }, { size = var.db.data_gib, iops = var.db.data_iops, throughput = var.db.data_throughput_mibps }] : disk.size == floor(disk.size) && disk.size >= 20 && disk.size <= 16384 && disk.iops == floor(disk.iops) && disk.iops >= 3000 && disk.iops <= 16000 && disk.throughput == floor(disk.throughput) && disk.throughput >= 125 && disk.throughput <= 1000 && disk.throughput <= disk.iops / 4 && disk.iops <= max(3000, disk.size * 500)])
    error_message = "Use reviewed integer gp3 sizes/performance within this conservative 3000-16000 IOPS/125-1000 MiB/s envelope and gp3 ratios."
  }
  validation {
    condition     = var.db.ebs_kms_key_arn == null ? true : can(regex("^arn:aws:kms:ap-northeast-2:[0-9]{12}:key/[a-f0-9-]+$", var.db.ebs_kms_key_arn))
    error_message = "Use null only after approving account-default EBS encryption, otherwise an exact Seoul KMS key ARN. No new key is created."
  }
  validation {
    condition     = alltrue([for name in [var.db.database, var.db.migration_role, var.db.application_role] : can(regex("^[a-z][a-z0-9_]{1,39}$", name)) && !startswith(name, "pg_") && !contains(["postgres", "template0", "template1", "public"], name)]) && var.db.migration_role != var.db.application_role
    error_message = "Provide separate reviewed migration-owner/runtime-DML roles and a non-system database (2-40 safe characters)."
  }
  validation {
    condition     = alltrue([for arn in [var.db.migration_secret_arn, var.db.application_secret_arn] : can(regex("^arn:aws:ssm:ap-northeast-2:${var.aws_account_id}:parameter/[a-zA-Z0-9_./-]+$", arn))]) && var.db.migration_secret_arn != var.db.application_secret_arn
    error_message = "Provide two distinct exact same-account Seoul SecureString parameter ARNs, never values. IAM/KMS approval is separate."
  }
  validation {
    condition     = can(regex("^/[a-zA-Z0-9_/-]+$", var.db.pg_bin)) && alltrue([for name in [var.db.ssm_service, var.db.chrony_service] : can(regex("^[a-zA-Z0-9_-]+\\.service$", name))])
    error_message = "Use a reviewed absolute PG16 binary directory and exact AL2023 systemd service names."
  }
}
