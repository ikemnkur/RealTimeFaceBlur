-- FaceBlurr — Stripe subscriptions table
-- Tracks user subscription state for admin review and billing management.

CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(10) NOT NULL,
  `username` VARCHAR(50) DEFAULT NULL,
  `stripe_subscription_id` VARCHAR(255) NOT NULL,
  `stripe_customer_id` VARCHAR(255) DEFAULT NULL,
  `plan_id` VARCHAR(50) DEFAULT NULL,
  `plan_name` VARCHAR(100) DEFAULT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'active',
  `current_period_start` TIMESTAMP NULL DEFAULT NULL,
  `current_period_end` TIMESTAMP NULL DEFAULT NULL,
  `cancel_at_period_end` TINYINT(1) DEFAULT 0,
  `canceled_at` TIMESTAMP NULL DEFAULT NULL,
  `trial_start` TIMESTAMP NULL DEFAULT NULL,
  `trial_end` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stripe_subscription_id` (`stripe_subscription_id`),
  KEY `idx_sub_user_id` (`user_id`),
  KEY `idx_sub_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;