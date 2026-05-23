-- Drauwper — User notifications
-- System alerts for drop events, contributions, purchases, and moderation

CREATE TABLE
  `notifications` (
    `id` varchar(10) NOT NULL,
    `userId` varchar(10) NOT NULL,
    `type` varchar(50) NOT NULL,
    `title` varchar(255) NOT NULL,
    `message` text,
    `priority` enum('success', 'info', 'warning', 'error') DEFAULT 'info',
    `category` enum(
      'drop_released',
      'goal_reached',
      'contribution_received',
      'contribution_refunded',
      'credit_purchase',
      'download_available',
      'review_received',
      'account',
      'moderation',
      'system'
    ) NOT NULL DEFAULT 'system',
    `relatedDropId` varchar(36) DEFAULT NULL,
    `actionUrl` varchar(255) DEFAULT NULL,
    `isRead` tinyint(1) DEFAULT 0,
    `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_userId` (`userId`),
    KEY `idx_category` (`category`),
    KEY `idx_isRead` (`isRead`),
    CONSTRAINT `fk_notifications_user` FOREIGN KEY (`userId`) REFERENCES `userData` (`id`) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci