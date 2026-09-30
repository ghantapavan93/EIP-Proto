# Backstop — the stated production shape, as code.
#
# NOT APPLIED. This is the Terraform ADR-004 promises, mirroring
# docker-compose.yml: one ECS Fargate task (nginx UI gateway + API) behind an
# HTTPS load balancer, RDS Postgres, a nightly scheduled task that re-checks
# rule sources and runs the gate, and an alert when that gate goes RED.
# Rough run cost: one small Fargate task + db.t4g.micro ≈ tens of dollars a month.
#
# CI runs `terraform fmt -check` and `terraform validate`. Apply only after
# whoever owns EIP's AWS account has reviewed the variables.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.project, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------- storage

# Intended for page snapshots, cassettes and evidence exports. The app does not
# write to S3 yet; the bucket is private, encrypted and versioned from day one.
resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.project}-artifacts-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ---------------------------------------------------------------- secrets
# Nothing sensitive is a plain task-definition variable: ECS injects these at
# start, and only the execution role can read them.

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.project}/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql+psycopg://backstop:${var.db_password}@${aws_db_instance.postgres.address}:5432/backstop"
}

resource "aws_secretsmanager_secret" "users" {
  name = "${var.project}/users"
}

resource "aws_secretsmanager_secret_version" "users" {
  secret_id     = aws_secretsmanager_secret.users.id
  secret_string = var.backstop_users
}

resource "aws_secretsmanager_secret" "model_key" {
  count = var.enable_model_key ? 1 : 0
  name  = "${var.project}/anthropic-api-key"
}

resource "aws_secretsmanager_secret_version" "model_key" {
  count         = var.enable_model_key ? 1 : 0
  secret_id     = aws_secretsmanager_secret.model_key[0].id
  secret_string = var.anthropic_api_key
}

locals {
  container_secrets = concat(
    [
      { name = "BACKSTOP_DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "BACKSTOP_USERS", valueFrom = aws_secretsmanager_secret.users.arn },
    ],
    [for s in aws_secretsmanager_secret.model_key : { name = "ANTHROPIC_API_KEY", valueFrom = s.arn }],
  )
  container_env = [
    { name = "BACKSTOP_ENVIRONMENT_LABEL", value = "STAGING · SYNTHETIC DATA" },
    # Artifact pages are replayed from frozen snapshots; crawling EIP's sites
    # needs the site owner's sign-off first.
    { name = "BACKSTOP_CRAWLER_LIVE", value = "false" },
  ]
}

# ---------------------------------------------------------------- database

resource "aws_db_subnet_group" "db" {
  name       = "${var.project}-db"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "postgres" {
  identifier                 = "${var.project}-db"
  engine                     = "postgres"
  engine_version             = "16"
  instance_class             = "db.t4g.micro"
  allocated_storage          = 20
  db_name                    = "backstop"
  username                   = "backstop"
  password                   = var.db_password
  db_subnet_group_name       = aws_db_subnet_group.db.name
  vpc_security_group_ids     = [aws_security_group.db.id]
  publicly_accessible        = false
  storage_encrypted          = true
  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  # The audit log lives here; losing it by a mistyped destroy is not an option.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project}-db-final"
}

# ---------------------------------------------------------------- network rules
# Three security groups, each admitting only the hop in front of it:
# allowed CIDRs -> ALB :443/:80 -> UI gateway :80 -> (same task) API -> DB :5432.
# Standalone rule resources avoid the ALB <-> service reference cycle.

resource "aws_security_group" "alb" {
  name   = "${var.project}-alb"
  vpc_id = var.vpc_id
}

resource "aws_security_group" "service" {
  name   = "${var.project}-service"
  vpc_id = var.vpc_id
}

resource "aws_security_group" "db" {
  name   = "${var.project}-db"
  vpc_id = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  for_each          = toset(var.allowed_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

# Tasks reach AWS APIs, rule-source pages and model providers over HTTPS.
resource "aws_vpc_security_group_egress_rule" "service_https" {
  security_group_id = aws_security_group.service.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "service_to_db" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "db_from_service" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ---------------------------------------------------------------- IAM

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what ECS itself needs to start the task (pull, log, inject secrets).
resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_secrets" {
  name = "${var.project}-secrets"
  role = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for s in local.container_secrets : s.valueFrom]
    }]
  })
}

# Task role: what the application code may do. Today: the artifacts bucket only.
resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task_s3" {
  name = "${var.project}-s3"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    }]
  })
}

# ---------------------------------------------------------------- compute

resource "aws_ecs_cluster" "this" {
  name = var.project
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}"
  retention_in_days = 90
}

locals {
  log_options = {
    awslogs-group  = aws_cloudwatch_log_group.app.name
    awslogs-region = var.region
  }
}

# One task, two containers, same shape as docker-compose.yml: nginx is the only
# port the load balancer sees and proxies /api to the API over the task's
# shared loopback. Migrations run before the API starts; seeding is idempotent.
resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([
    {
      name         = "api"
      image        = var.api_image
      essential    = true
      portMappings = [{ containerPort = 8000, protocol = "tcp" }]
      environment  = local.container_env
      secrets      = local.container_secrets
      command      = ["sh", "-c", "cd /app/backend && alembic upgrade head && backstop seed && backstop serve --host 127.0.0.1 --port 8000"]
      healthCheck = {
        command     = ["CMD-SHELL", "python -c \"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')\""]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 120
      }
      logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-stream-prefix = "api" }) }
    },
    {
      name             = "ui"
      image            = var.ui_image
      essential        = true
      portMappings     = [{ containerPort = 80, protocol = "tcp" }]
      environment      = [{ name = "BACKSTOP_API_UPSTREAM", value = "127.0.0.1:8000" }]
      dependsOn        = [{ containerName = "api", condition = "HEALTHY" }]
      logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-stream-prefix = "ui" }) }
    },
  ])
}

resource "aws_ecs_service" "app" {
  name                              = "${var.project}-app"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 180
  # A new task must be healthy before the old one stops: no gap during deploys.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.ui.arn
    container_name   = "ui"
    container_port   = 80
  }
  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------- nightly gate
# Re-hash every rule's primary source (live: these are public cms.gov / eCFR /
# FCC pages), rescan the artifact snapshots, then run the gate under the rules
# in force today. A non-zero exit is the alarm (see alerts below).

resource "aws_ecs_task_definition" "nightly" {
  family                   = "${var.project}-nightly"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name        = "nightly"
    image       = var.api_image
    essential   = true
    environment = local.container_env
    secrets     = local.container_secrets
    command = ["sh", "-c", join(" && ", [
      "backstop check-sources --live",
      "backstop scan --as-of $(date +%F)",
      "backstop run --prompt 2 --model ${var.nightly_model} --rule-date $(date +%F) --trigger RULE --gate",
    ])]
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-stream-prefix = "nightly" }) }
  }])
}

resource "aws_iam_role" "scheduler" {
  name = "${var.project}-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "scheduler.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "scheduler_run_task" {
  name = "${var.project}-scheduler-run-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:RunTask"], Resource = [aws_ecs_task_definition.nightly.arn] },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn] },
    ]
  })
}

# EventBridge Scheduler, not a plain cron rule: plain rules run in UTC, so a
# 07:00 UTC cron drifts to 03:00 Eastern every March. This one follows DST.
resource "aws_scheduler_schedule" "nightly" {
  name                         = "${var.project}-nightly"
  schedule_expression          = "cron(0 2 * * ? *)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.nightly.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.service.id]
        assign_public_ip = false
      }
    }
  }
}

# ---------------------------------------------------------------- alerts
# The nightly task exits 1 when the gate is RED or a step fails. ECS emits a
# task-state event when it stops; any non-zero container exit goes to SNS.

# Unencrypted on purpose: EventBridge cannot publish to a topic encrypted with
# the AWS-managed SNS key, and alerts carry a task ARN and exit code, never call data.
resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_event_rule" "nightly_failed" {
  name = "${var.project}-nightly-failed"
  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.this.arn]
      group      = ["family:${aws_ecs_task_definition.nightly.family}"]
      lastStatus = ["STOPPED"]
      containers = { exitCode = [{ "anything-but" = 0 }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "nightly_failed" {
  rule = aws_cloudwatch_event_rule.nightly_failed.name
  arn  = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.alerts.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.nightly_failed.arn } }
    }]
  })
}

# ---------------------------------------------------------------- ingress

resource "aws_lb" "this" {
  name                       = "${var.project}-alb"
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "ui" {
  name        = "${var.project}-ui"
  port        = 80
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  # Through nginx to the API: healthy only when both containers answer.
  health_check {
    path    = "/api/health"
    matcher = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ui.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
