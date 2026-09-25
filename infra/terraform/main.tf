# Backstop — the stated production shape, as code.
#
# NOT APPLIED. This is the one-file Terraform that ADR-004 promises: one ECS
# Fargate service behind an ALB, RDS Postgres, a scheduled ECS task for
# nightly scans + canary runs, S3 for page snapshots and cassettes, and the
# model key in Secrets Manager. Docker Compose is the deliverable for the
# demo; this file shows where it goes next and what it would cost to run
# (roughly: one small Fargate task + db.t4g.micro ≈ tens of dollars a month).
#
# Validate with `terraform init && terraform validate` (needs the AWS
# provider); apply only after the variables below are reviewed by whoever
# owns EIP's AWS account.

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
}

# ---------------------------------------------------------------- variables

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "backstop"
}

variable "image" {
  type        = string
  description = "ECR image URI for the API (built from backend/Dockerfile)"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

# ---------------------------------------------------------------- storage

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.project}-artifacts-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------- secrets

resource "aws_secretsmanager_secret" "model_key" {
  name = "${var.project}/anthropic-api-key"
}

resource "aws_secretsmanager_secret_version" "model_key" {
  secret_id     = aws_secretsmanager_secret.model_key.id
  secret_string = var.anthropic_api_key
}

# ---------------------------------------------------------------- database

resource "aws_db_subnet_group" "db" {
  name       = "${var.project}-db"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  name   = "${var.project}-db"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "postgres" {
  identifier             = "${var.project}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t4g.micro"
  allocated_storage      = 20
  db_name                = "backstop"
  username               = "backstop"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
  backup_retention_period = 7
  deletion_protection    = false
}

# ---------------------------------------------------------------- compute

resource "aws_ecs_cluster" "this" {
  name = var.project
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.project}"
  retention_in_days = 90
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
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
      Resource = [aws_secretsmanager_secret.model_key.arn]
    }]
  })
}

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

locals {
  container_env = [
    { name = "BACKSTOP_DATABASE_URL", value = "postgresql+psycopg://backstop:${var.db_password}@${aws_db_instance.postgres.address}:5432/backstop" },
    { name = "BACKSTOP_ENVIRONMENT_LABEL", value = "STAGING · SYNTHETIC DATA" },
    { name = "BACKSTOP_CRAWLER_LIVE", value = "false" },
  ]
  container_secrets = [
    { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.model_key.arn },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.image
    essential    = true
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    environment  = local.container_env
    secrets      = local.container_secrets
    command      = ["sh", "-c", "backstop seed && backstop serve --host 0.0.0.0 --port 8000"]
    healthCheck = {
      command  = ["CMD-SHELL", "python -c \"import urllib.request;urllib.request.urlopen('http://localhost:8000/api/health')\""]
      interval = 30
      timeout  = 5
      retries  = 3
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

# Nightly: replay snapshots (or crawl, if allowed), re-check rule sources, run the gate.
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
    image       = var.image
    essential   = true
    environment = local.container_env
    secrets     = local.container_secrets
    command = ["sh", "-c", join(" && ", [
      "backstop scan --as-of $(date +%F)",
      "backstop check-sources",
      "backstop run --prompt 2 --model sim-large --rule-date $(date +%F) --trigger RULE --gate",
    ])]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "nightly"
      }
    }
  }])
}

resource "aws_security_group" "service" {
  name   = "${var.project}-service"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_service" "api" {
  name            = "${var.project}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.service.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }
  depends_on = [aws_lb_listener.http]
}

# ---------------------------------------------------------------- scheduling

resource "aws_cloudwatch_event_rule" "nightly" {
  name                = "${var.project}-nightly"
  schedule_expression = "cron(0 7 * * ? *)" # 02:00 America/New_York during EST
}

resource "aws_iam_role" "events" {
  name               = "${var.project}-events"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "events.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "events_run_task" {
  name = "${var.project}-events-run-task"
  role = aws_iam_role.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:RunTask"], Resource = [aws_ecs_task_definition.nightly.arn] },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn] },
    ]
  })
}

resource "aws_cloudwatch_event_target" "nightly" {
  rule     = aws_cloudwatch_event_rule.nightly.name
  arn      = aws_ecs_cluster.this.arn
  role_arn = aws_iam_role.events.arn
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.nightly.arn
    launch_type         = "FARGATE"
    network_configuration {
      subnets         = var.private_subnet_ids
      security_groups = [aws_security_group.service.id]
    }
  }
}

# ---------------------------------------------------------------- ingress

resource "aws_security_group" "alb" {
  name   = "${var.project}-alb"
  vpc_id = var.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # narrow to EIP's egress IPs before real use
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name               = "${var.project}-alb"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${var.project}-api"
  port        = 8000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path = "/api/health"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

output "api_url" {
  value = "http://${aws_lb.this.dns_name}"
}
