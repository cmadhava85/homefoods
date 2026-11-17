-- Post–cut-off cancel: customer requests → cook Accept (refund) or Decline (keep PAID)
ALTER TYPE "order_state" ADD VALUE IF NOT EXISTS 'CANCEL_REQUESTED' AFTER 'PAID';
