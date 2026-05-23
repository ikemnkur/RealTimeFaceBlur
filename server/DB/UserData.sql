-- Drauwper — Core user accounts table
-- Stores authentication, profile, moderation, and wallet data for all platform users

CREATE TABLE
  `userData` (
    `id` varchar(10) NOT NULL,
    `username` varchar(50) NOT NULL,
    `email` varchar(100) NOT NULL,
    `passwordHash` varchar(255) NOT NULL,
    `credits` int NOT NULL DEFAULT 0,

    `lastLogin` datetime DEFAULT NULL,
    `loginStatus` tinyint(1) DEFAULT 0,

    -- User profile / identification
    `firstName` varchar(50) DEFAULT NULL,
    `lastName` varchar(50) DEFAULT NULL,
    `phoneNumber` varchar(20) DEFAULT NULL,
    `birthDate` date DEFAULT NULL,

    -- Moderation and security
    -- `encryptionKey` varchar(100) DEFAULT NULL,
    `reportCount` int DEFAULT 0,
    `isBanned` tinyint(1) DEFAULT 0,
    `banReason` text,
    `banDate` datetime DEFAULT NULL,
    `banDuration` int DEFAULT NULL,
    `createdAt` bigint DEFAULT NULL,
    `updatedAt` bigint DEFAULT NULL,

    `twoFactorEnabled` tinyint(1) DEFAULT 0,
    `twoFactorSecret` varchar(50) DEFAULT NULL,
    `recoveryCodes` json DEFAULT NULL,

    -- Drauwper account tiers: free users can contribute, creators can host drops, premium gets priority
    `accountType` enum('free', 'pro', 'advanced') DEFAULT 'free',
    `planExpiry` timestamp NULL DEFAULT NULL,

    -- Creator-specific fields
    -- `totalDropsCreated` int DEFAULT 0,
    -- `totalCreditsEarned` bigint DEFAULT 0,
    -- `creatorRating` decimal(4,2) DEFAULT NULL,

    -- Profile & social
    -- `profilePicture` varchar(255) DEFAULT NULL,
    -- `bio` text,
    -- `socialLinks` json DEFAULT NULL,

    -- Crypto micro-payment verification
    -- `verification` varchar(10) DEFAULT 'none',
    -- `amount1` double DEFAULT NULL,
    -- `amount2` double DEFAULT NULL,
    -- `cryptoAmounts` varchar(255) DEFAULT NULL,

    -- Verification document review
    `verificationFacePath` varchar(255) DEFAULT NULL,
    `verificationIdPath` varchar(255) DEFAULT NULL,
    `verificationDocsStatus` varchar(32) DEFAULT NULL,
    `verificationDocsNotes` text,
    `verificationDocsReviewedAt` datetime DEFAULT NULL,
    `verificationDocsReviewedBy` varchar(100) DEFAULT NULL,

    -- Password reset
    `resetCode` varchar(6) DEFAULT NULL,
    `resetCodeExpiry` datetime DEFAULT NULL,

    PRIMARY KEY (`id`),
    UNIQUE KEY `username` (`username`),
    UNIQUE KEY `email` (`email`),
    KEY `idx_accountType` (`accountType`)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci