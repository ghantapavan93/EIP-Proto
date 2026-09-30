output "url" {
  value       = "https://${aws_lb.this.dns_name}"
  description = "Point a DNS name covered by certificate_arn at this."
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
