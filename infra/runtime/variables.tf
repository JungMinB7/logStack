variable "aws_account_id" {
  description = "Human-approved deployment account ID; credentials use the external AWS credential chain."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Provide the approved 12-digit account ID."
  }
}

variable "project" {
  type    = string
  default = "logstack-demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,29}$", var.project))
    error_message = "Project must be 2-30 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "environment" {
  type    = string
  default = "demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.environment))
    error_message = "Environment must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "availability_zones" {
  description = "Approved candidates only; verify availability and endpoint support in the actual account before plan."
  type        = object({ a = string, c = string })
  default     = { a = "ap-northeast-2a", c = "ap-northeast-2c" }
  validation {
    condition     = var.availability_zones.a == "ap-northeast-2a" && var.availability_zones.c == "ap-northeast-2c"
    error_message = "T4 approved candidates are Seoul a/c; unavailable candidates require a design decision."
  }
}

variable "s3_read_paths" {
  description = "Approved SSM/package read paths only; empty denies all S3 endpoint access. No secrets, backup writes or implicit buckets."
  type = map(object({
    bucket = string
    prefix = string
    roles  = set(string)
  }))
  default  = {}
  nullable = false
  validation {
    condition = alltrue([for grant in values(var.s3_read_paths) :
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", grant.bucket)) &&
      length(grant.prefix) > 0 && endswith(grant.prefix, "/") &&
      !startswith(grant.prefix, "/") && length(regexall("[?*]", grant.prefix)) == 0 &&
      length(grant.roles) > 0 && length(setsubtract(grant.roles, toset(["sender", "receiver", "db"]))) == 0
    ])
    error_message = "Use an exact bucket, nonempty path ending / without wildcards, and sender/receiver/db roles."
  }
}
