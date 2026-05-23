CREATE TABLE emailVerifications (
id INT NOT NULL AUTO_INCREMENT,
email VARCHAR(100) NOT NULL,
code VARCHAR(10) NOT NULL,
expiresAt DATETIME NOT NULL,
createdAt DATETIME NOT NULL,
used TINYINT(1) DEFAULT 0,
PRIMARY KEY (id),
KEY idx_email (email),
KEY idx_expires (expiresAt),
CONSTRAINT fk_emailVerifications_userData_email
FOREIGN KEY (email) REFERENCES userData (email)
ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;