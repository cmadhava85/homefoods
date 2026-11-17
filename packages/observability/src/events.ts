/**
 * Stable `event` field values for Cloud Logging log-based metrics.
 * Keep names short, dotted, and never rename without updating Terraform filters.
 */
export const LogEvent = {
  WEBHOOK_SIGNATURE_FAILED: "webhook.signature_failed",
  WEBHOOK_HANDLER_FAILED: "webhook.handler_failed",
  PAYMENT_CONFIRMING_STUCK: "payment.confirming_stuck",
  ORDER_CREATED: "order.created",
  ORDER_PAID: "order.paid",
  ORDER_UNPAID_EXPIRED: "order.unpaid_expired",
  OUTBOX_PROCESSED: "outbox.processed",
  OUTBOX_FAILED: "outbox.failed",
  OUTBOX_SKIPPED: "outbox.skipped",
  WA_SEND_FAILED: "whatsapp.send_failed",
  CUTOFF_REACHED: "cutoff.reached",
  SETTLEMENT_BATCH_COMPLETED: "settlement.batch_completed",
  SETTLEMENT_BATCH_FAILED: "settlement.batch_failed",
  WORKER_STARTED: "worker.started",
  REQUEST_FAILED: "request.failed",
  REQUEST_COMPLETED: "request.completed",
} as const;

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];
