-- FaceBlurr — Stripe transaction tracking table
-- Stores both PaymentIntent snapshots and Stripe balance-history transactions.
-- Non-duplicate by PaymentIntent ID, charge ID, or balance transaction ID.

CREATE TABLE IF NOT EXISTS `stripeTransactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `stripeObjectType` VARCHAR(50) DEFAULT 'payment_intent',
  `stripeBalanceTransactionId` VARCHAR(255) NULL,
  `stripePaymentIntentId` VARCHAR(255) NULL,
  `stripeChargeId` VARCHAR(255) NULL,
  `stripeCheckoutSessionId` VARCHAR(255) DEFAULT NULL,
  `stripeCustomerId` VARCHAR(255) DEFAULT NULL,
  `stripeInvoiceId` VARCHAR(255) DEFAULT NULL,
  `stripeSubscriptionId` VARCHAR(255) DEFAULT NULL,
  `stripeSourceId` VARCHAR(255) DEFAULT NULL,
  `stripeSourceType` VARCHAR(50) DEFAULT NULL,

  `status` VARCHAR(50) NOT NULL DEFAULT 'unknown',
  `amount` INT NOT NULL DEFAULT 0 COMMENT 'Smallest currency unit, e.g. cents',
  `amountReceived` INT NOT NULL DEFAULT 0 COMMENT 'Smallest currency unit, e.g. cents',
  `fee` INT NOT NULL DEFAULT 0 COMMENT 'Stripe fee in smallest currency unit',
  `net` INT NOT NULL DEFAULT 0 COMMENT 'Net amount after fees in smallest currency unit',
  `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
  `paymentMethodTypes` JSON DEFAULT NULL,

  `description` TEXT,
  `receiptEmail` VARCHAR(255) DEFAULT NULL,
  `customerEmail` VARCHAR(255) DEFAULT NULL,
  `customerName` VARCHAR(255) DEFAULT NULL,
  `livemode` TINYINT(1) NOT NULL DEFAULT 0,

  `metadata` JSON DEFAULT NULL,
  `rawPayload` JSON DEFAULT NULL COMMENT 'Full Stripe object payload for audit/debug',

  `stripeCreatedAt` DATETIME DEFAULT NULL,
  `availableOn` DATETIME DEFAULT NULL,
  `syncedAt` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stripe_payment_intent` (`stripePaymentIntentId`),
  UNIQUE KEY `uq_stripe_charge` (`stripeChargeId`),
  UNIQUE KEY `uq_stripe_balance_txn` (`stripeBalanceTransactionId`),
  KEY `idx_stripe_customer` (`stripeCustomerId`),
  KEY `idx_stripe_status` (`status`),
  KEY `idx_stripe_created_at` (`stripeCreatedAt`),
  KEY `idx_stripe_source_id` (`stripeSourceId`),
  KEY `idx_stripe_object_type` (`stripeObjectType`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;