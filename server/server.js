require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const knex = require('./config/knex');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
// const axios = require('axios');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const cron = require('node-cron');

// const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const util = require('util'); // Node.js utility for formatting arguments
// const emailService = require('./AmazonSESemailService.cjs');
const emailService = require('./email-service');

// const authenticateToken = require('../middleware/auth');
const authenticateToken = require('./middleware/auth');
const createAdminRouter = require('./server-admin');
// const FaceBlurrRoutes = require('./FaceBlurr-routes');
// const pythonService = require('./python-service.cjs');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cookieParser = require('cookie-parser');

const server = express();

const PROXY = process.env.PROXY || '';

// ── Global date utility ────────────────────────────────────────────────────
// Converts a Unix timestamp (seconds from Stripe, or ms from Date.now()) to
// a MySQL DATETIME string. Stripe timestamps are seconds (< 2e10).
function toMySQLDateTime(value) {
    if (value == null) return null;
    const ms = typeof value === 'number' && value < 2e10 ? value * 1000 : Number(value);
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// ── Stripe webhook — MUST be registered before express.json() ──
// Stripe requires the raw request body to verify the signature.
server.post(
    PROXY + '/api/webhook/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const sig = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;

        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } catch (err) {
            console.error('Webhook signature verification failed:', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        console.log(`📩 Stripe webhook received: ${event.type}`);

        try {
            switch (event.type) {

                // ── Subscription checkout completed ──────────────────────
                case 'checkout.session.completed': {
                    const session = event.data.object;
                    if (session.mode !== 'subscription') break;

                    const subId = session.subscription;
                    const customerId = session.customer;
                    const clientRef = session.client_reference_id || '';
                    const underscoreIdx = clientRef.lastIndexOf('_');
                    let userId = underscoreIdx > 0
                        ? clientRef.substring(0, underscoreIdx)
                        : clientRef;
                    let planId = underscoreIdx > 0
                        ? clientRef.substring(underscoreIdx + 1)
                        : null;
                    userId    = session.metadata?.userId    || userId;
                    planId    = session.metadata?.planId    || planId    || 'pro';
                    const planName = session.metadata?.planName
                        || (planId.charAt(0).toUpperCase() + planId.slice(1));

                    // Fetch full subscription for period dates
                    const sub = await stripe.subscriptions.retrieve(subId);

                    await knex.raw(
                        `INSERT INTO subscriptions
                         (user_id, stripe_subscription_id, stripe_customer_id, plan_id, plan_name,
                          status, current_period_start, current_period_end, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                         ON DUPLICATE KEY UPDATE
                           stripe_customer_id      = VALUES(stripe_customer_id),
                           plan_id                 = VALUES(plan_id),
                           plan_name               = VALUES(plan_name),
                           status                  = VALUES(status),
                           current_period_start    = VALUES(current_period_start),
                           current_period_end      = VALUES(current_period_end)`,
                        [
                            userId, subId, customerId, planId, planName,
                            sub.status,
                            new Date(sub.current_period_start * 1000),
                            new Date(sub.current_period_end   * 1000),
                        ]
                    );
                    await knex('userData').where({ id: userId }).update({ accountType: planId });
                    console.log(`✅ Subscription activated via webhook: user=${userId} plan=${planId}`);
                    break;
                }

                // ── Subscription updated (renewal, plan change, etc.) ────
                case 'customer.subscription.updated': {
                    const sub = event.data.object;
                    const planId = sub.metadata?.planId || sub.items?.data[0]?.plan?.nickname?.toLowerCase() || null;

                    const updateData = {
                        status:                sub.status,
                        current_period_start:  new Date(sub.current_period_start * 1000),
                        current_period_end:    new Date(sub.current_period_end   * 1000),
                        cancel_at_period_end:  sub.cancel_at_period_end ? 1 : 0,
                        canceled_at:           sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
                        updated_at:            new Date(),
                    };
                    if (planId) {
                        updateData.plan_id   = planId;
                        updateData.plan_name = planId.charAt(0).toUpperCase() + planId.slice(1);
                    }

                    const rows = await knex('subscriptions')
                        .where({ stripe_subscription_id: sub.id })
                        .update(updateData);

                    if (rows && planId) {
                        // Also sync accountType on the user record
                        const subRow = await knex('subscriptions')
                            .where({ stripe_subscription_id: sub.id })
                            .select('user_id')
                            .first();
                        if (subRow) {
                            await knex('userData').where({ id: subRow.user_id }).update({ accountType: planId });
                        }
                    }
                    console.log(`✅ Subscription updated: ${sub.id} status=${sub.status}`);
                    break;
                }

                // ── Subscription deleted / fully cancelled ───────────────
                case 'customer.subscription.deleted': {
                    const sub = event.data.object;
                    const subRow = await knex('subscriptions')
                        .where({ stripe_subscription_id: sub.id })
                        .select('user_id')
                        .first();

                    await knex('subscriptions')
                        .where({ stripe_subscription_id: sub.id })
                        .update({
                            status:      'canceled',
                            canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000) : new Date(),
                            updated_at:  new Date(),
                        });

                    if (subRow) {
                        await knex('userData').where({ id: subRow.user_id }).update({ accountType: 'free' });
                        console.log(`✅ Subscription cancelled: user=${subRow.user_id} → downgraded to free`);
                    }
                    break;
                }

                // ── Successful renewal payment ───────────────────────────
                case 'invoice.payment_succeeded': {
                    const invoice = event.data.object;
                    if (!invoice.subscription) break;
                    const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                    await knex('subscriptions')
                        .where({ stripe_subscription_id: invoice.subscription })
                        .update({
                            status:               sub.status,
                            current_period_start: new Date(sub.current_period_start * 1000),
                            current_period_end:   new Date(sub.current_period_end   * 1000),
                            updated_at:           new Date(),
                        });
                    console.log(`✅ Invoice paid — subscription renewed: ${invoice.subscription}`);
                    break;
                }

                // ── Failed renewal payment ───────────────────────────────
                case 'invoice.payment_failed': {
                    const invoice = event.data.object;
                    if (!invoice.subscription) break;
                    await knex('subscriptions')
                        .where({ stripe_subscription_id: invoice.subscription })
                        .update({ status: 'past_due', updated_at: new Date() });
                    console.warn(`⚠️  Invoice payment failed for subscription: ${invoice.subscription}`);
                    break;
                }

                default:
                    // Unhandled event type — safe to ignore
                    break;
            }
        } catch (handlerErr) {
            console.error('Webhook handler error:', handlerErr);
            // Still return 200 so Stripe doesn't retry; log for investigation
        }

        res.json({ received: true });
    }
);

// ── Global middleware ────────────────────────────────────────────
server.use(cookieParser());
server.use(require('cors')({
    origin: function (origin, callback) {
        const allowed = [
            'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002',
            'http://localhost:4000', 'http://localhost:5001',
            'https://faceblurr.com', 'https://www.faceblurr.com',
            'https://editor-pavement-encircle.ngrok-free.dev',
            'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
            'http://142.93.82.161', 'https://server.faceblurr.com',
            'https://js.stripe.com',
        ];
        // origin === 'null' happens when pages are loaded from file:// in dev
        // Also allow all Vercel preview deployment URLs (*.vercel.app)
        const isVercelPreview = origin && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
        if (!origin || origin === 'null' || isVercelPreview || allowed.includes(origin)) return callback(null, true);
        console.log('❌ CORS blocked origin:', origin);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Authorization'],
    optionsSuccessStatus: 200,
    maxAge: 86400,
}));
server.use(express.json({ limit: '10mb' }));
server.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Database configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'FaceBlurr',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: 0
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Helper function to build INSERT queries from objects
function buildInsert(tableName, data) {
    const columns = Object.keys(data);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(data);

    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
    return { sql, values };
}

// Analytics tracking
const analytics = {
    visitors: new Set(), // Unique IP addresses
    users: new Set(), // Unique user accounts
    totalRequests: 0,
    dataTx: 0, // Data transmitted (bytes)
    dataRx: 0, // Data received (bytes)
    endpointCalls: {}, // Tally of each endpoint
    startTime: Date.now()
};

// Logs storage
const logs = {
    maxLogs: 500, // Keep last 500 logs
    entries: []
};

// Override console methods to capture logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = function (...args) {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    logs.entries.push({
        type: 'info',
        message: message,
        timestamp: new Date().toISOString(),
        time: Date.now()
    });
    if (logs.entries.length > logs.maxLogs) {
        logs.entries.shift();
    }
    originalConsoleLog.apply(console, args);
};

console.error = function (...args) {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    logs.entries.push({
        type: 'error',
        message: message,
        timestamp: new Date().toISOString(),
        time: Date.now()
    });
    if (logs.entries.length > logs.maxLogs) {
        logs.entries.shift();
    }
    originalConsoleError.apply(console, args);
};

console.warn = function (...args) {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    logs.entries.push({
        type: 'warn',
        message: message,
        timestamp: new Date().toISOString(),
        time: Date.now()
    });
    if (logs.entries.length > logs.maxLogs) {
        logs.entries.shift();
    }
    originalConsoleWarn.apply(console, args);
};

const FRONTEND_URL = process.env.FRONTEND_URL || "faceblurr.com";

// Root route
server.get('/', (req, res) => {
    const initialUptimeSeconds = Math.max(0, Math.floor((Date.now() - analytics.startTime) / 1000));
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FaceBlurr Server</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      color: #1f2937;
    }
    .card {
      width: min(92vw, 560px);
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
      text-align: center;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 1.6rem;
    }
    p {
      margin: 8px 0;
      line-height: 1.4;
    }
    .uptime {
      margin: 12px 0 20px;
      font-weight: 700;
      color: #111827;
    }
    .btn {
      display: inline-block;
      text-decoration: none;
      color: #ffffff;
      background: #2563eb;
      border-radius: 8px;
      padding: 10px 14px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Welcome to FaceBlurr Server</h1>
    <p>Backend service is running.</p>
    <p class="uptime">Uptime: <span id="uptime">0s</span></p>
    <a class="btn" href="/admin/login">Go to Admin Login</a>
  </main>
  <script>
    const startedAtSeconds = ${initialUptimeSeconds};
    const startNow = Date.now();

    function formatDuration(totalSeconds) {
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const parts = [];
      if (days) parts.push(days + 'd');
      if (hours || days) parts.push(hours + 'h');
      if (minutes || hours || days) parts.push(minutes + 'm');
      parts.push(seconds + 's');
      return parts.join(' ');
    }

    function renderUptime() {
      const elapsed = Math.floor((Date.now() - startNow) / 1000);
      const total = startedAtSeconds + elapsed;
      document.getElementById('uptime').textContent = formatDuration(total);
    }

    renderUptime();
    setInterval(renderUptime, 1000);
  </script>
</body>
</html>`);
});




// ----------------------------------------------------
// Authentication Routes
// ----------------------------------------------------

// Custom authentication route
server.post(PROXY + '/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const users = await knex('userData')
            .where('email', email)
            .select('*');

        const user = users[0];

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check if user is banned
        if (user.isBanned) {
            return res.status(403).json({
                success: false,
                message: 'Account is banned',
                banReason: user.banReason
            });
        }

        // Compare password with hash
        const isValidPassword = await bcrypt.compare(password, user.passwordHash);

        if (isValidPassword) {
            // Update last login
            const currentDateTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
            await knex('userData')
                .where('email', email)
                .update({ loginStatus: true, lastLogin: currentDateTime });

            if (!user.twoFactorEnabled) {
                // No 2FA — issue full token directly
                const authResponse = await buildFullAuthResponse(user.id);
                return sendAuthResponse(res, authResponse);
            }

            // Issue a short-lived temp token for the TOTP step
            const tempToken = jwt.sign(
                { id: user.id, email: user.email, stage: 'pre_2fa' },
                process.env.JWT_SECRET,
                { expiresIn: '10m' }
            );
            return res.json({ requiresTOTP: true, tempToken });
        } else {
            res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during login'
        });
    }
});



// Custom fetch account details route
server.post(PROXY + '/api/user', authenticateToken, async (req, res) => {
    console.log("Fetching user details...");
    try {
        const { email, username } = req.body;
        //  console.log("User found:", user.username);
        // Validate input
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const users = await knex('userData')
            .where('email', email)
            .select('*');

        const user = users[0];

        const actions = await knex('actions')
            .where('email', email)
            .select('*');

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check if user is banned
        if (user.isBanned) {
            return res.status(403).json({
                success: false,
                message: 'Account is banned',
                banReason: user.banReason
            });
        }


        // Compare password with hash
        // const isValidPassword = await bcrypt.compare(password, user.passwordHash);

        // if (isValidPassword) {
        const userData = { ...user };
        delete userData.passwordHash; // Don't send password hash

        // Update last login with proper MySQL datetime format
        // const currentDateTime = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Generate a proper JWT-like token (in production, use actual JWT)
        // const token = Buffer.from(`${user.id}_${Date.now()}_${Math.random()}`).toString('base64');
        const token = jwt.sign({
            id: user.id,
            email: user.email,
            username: user.username,
            credits: user.credits
        }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });


        res.json({
            success: true,
            user: userData,
            unlocks: actions,
            dayPassExpiry: user.dayPassExpiry,
            dayPassMode: user.dayPassMode,
            planExpiry: user.planExpiry,
            token: token,
            tokenExpiry: new Date(Date.now() + 7200 * 1000),
            accountType: user.accountType,
            message: 'Login successful'
        });
        // }

        // } else {
        //   res.status(401).json({
        //     success: false,
        //     message: 'Invalid credentials'
        //   });
        // }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during login'
        });
    }
});


// Custom registration route
server.post(PROXY + '/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, firstName, lastName, accountType, birthDate } = req.body;

        // Validate required fields
        if (!username || !email || !password || !firstName) {
            return res.status(400).json({
                success: false,
                message: 'Username, email, password, and first name are required'
            });
        }

        // Check if username already exists
        const existingUsers = await knex('userData')
            .where('username', username)
            .orWhere('email', email)
            .select('id');

        if (existingUsers.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Username or email already exists'
            });
        }

        // Hash the password
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Helper function to convert ISO datetime to MySQL format
        const formatDateTimeForMySQL = (dateTime) => {
            if (!dateTime) return null;
            if (typeof dateTime === 'string') {
                return new Date(dateTime).toISOString().slice(0, 19).replace('T', ' ');
            }
            if (typeof dateTime === 'number') {
                return new Date(dateTime).toISOString().slice(0, 19).replace('T', ' ');
            }
            return null;
        };

        // Generate a unique ID (since the schema uses VARCHAR(10))
        const generateId = () => {
            return Math.random().toString(36).substring(2, 12).toUpperCase();
        };

        const userId = generateId();
        const currentTime = Date.now();
        const currentDateTime = formatDateTimeForMySQL(new Date());

        // gerate two small random amounts for verification above 10 cents USD, less than 20 cents.
        // const amount1 = (0.1 * parseFloat(Math.random().toFixed(8)) + 0.1).toPrecision(4);
        // const amount2 = (0.1 * parseFloat(Math.random().toFixed(8)) + 0.1).toPrecision(4);




        // convert random amounts to crypto amounts based on current rates
        // const btcRate = await fetchCryptoRate('BTC') || 45000;
        // const ethRate = await fetchCryptoRate('ETH') || 3000;
        // const ltcRate = await fetchCryptoRate('LTC') || 100;
        // const solRate = await fetchCryptoRate('SOL') || 150;
        // // const xmrRate = await fetchCryptoRate('XMR');
        // // const xrpRate = await fetchCryptoRate('XRP');
        // const amount1BTC = (amount1 / btcRate).toFixed(8);
        // const amount2BTC = (amount2 / btcRate).toFixed(8);
        // const amount1ETH = (amount1 / ethRate).toFixed(8);
        // const amount2ETH = (amount2 / ethRate).toFixed(8);
        // const amount1LTC = (amount1 / ltcRate).toFixed(8);
        // const amount2LTC = (amount2 / ltcRate).toFixed(8);
        // const amount1SOL = (amount1 / solRate).toFixed(8);
        // const amount2SOL = (amount2 / solRate).toFixed(8);
        // const amount1XMR = (amount1 / xmrRate).toFixed(8);
        // const amount2XMR = (amount2 / xmrRate).toFixed(8);
        // const amount1XRP = (amount1 / xrpRate).toFixed(8);
        // const amount2X

        const newUser = {
            id: userId,
            loginStatus: true,
            lastLogin: currentDateTime,
            accountType: accountType || 'free',
            username: username,
            email: email,
            firstName: firstName,
            lastName: lastName || '',
            phoneNumber: '',
            birthDate: birthDate || null,
            //   encryptionKey: `enc_key_${Date.now()}`,
            //   credits: 100, // Starting credits
            reportCount: 0,
            isBanned: false,
            banReason: '',
            banDate: null,
            banDuration: null,
            createdAt: currentTime,
            updatedAt: currentTime,
            passwordHash: passwordHash,
            twoFactorEnabled: false,
            twoFactorSecret: '',
            recoveryCodes: [],
            //   profilePicture: `https://i.pravatar.cc/150?img=${Math.floor(Math.random() * 70) + 1}`,
            //   bio: '',
            //   socialLinks: {}
        };

        // await pool.execute(
        //   'INSERT INTO userData (id, loginStatus, lastLogin, accountType, username, email, firstName, lastName, phoneNumber, birthDate, encryptionKey, credits, reportCount, isBanned, banReason, banDate, banDuration, createdAt, updatedAt, passwordHash, twoFactorEnabled, twoFactorSecret, recoveryCodes, profilePicture, bio, socialLinks, verification, amount1, amount2, cryptoAmounts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        //   [
        //     newUser.id,
        //     newUser.loginStatus,
        //     newUser.lastLogin,
        //     newUser.accountType,
        //     newUser.username,
        //     newUser.email,
        //     newUser.firstName,
        //     newUser.lastName,
        //     newUser.phoneNumber,
        //     newUser.birthDate,
        //     newUser.encryptionKey,
        //     newUser.credits,
        //     newUser.reportCount,
        //     newUser.isBanned,
        //     newUser.banReason,
        //     formatDateTimeForMySQL(newUser.banDate),
        //     newUser.banDuration,
        //     newUser.createdAt,
        //     newUser.updatedAt,
        //     newUser.passwordHash,
        //     newUser.twoFactorEnabled,
        //     newUser.twoFactorSecret,
        //     JSON.stringify(newUser.recoveryCodes),
        //     newUser.profilePicture,
        //     newUser.bio,
        //     JSON.stringify(newUser.socialLinks),
        //     "false",
        //     amount1,
        //     amount2,
        //     cryptoAmounts = JSON.stringify({
        //       BTC: { amount1: amount1BTC, amount2: amount2BTC },
        //       ETH: { amount1: amount1ETH, amount2: amount2ETH },
        //       LTC: { amount1: amount1LTC, amount2: amount2LTC },
        //       SOL: { amount1: amount1SOL, amount2: amount2SOL }
        //     })
        //   ]
        // );

        const insertData = {
            id: newUser.id,
            loginStatus: newUser.loginStatus,
            lastLogin: newUser.lastLogin,
            accountType: newUser.accountType,
            username: newUser.username,
            email: newUser.email,
            firstName: newUser.firstName,
            lastName: newUser.lastName,
            phoneNumber: newUser.phoneNumber,
            birthDate: newUser.birthDate,
            //   encryptionKey: newUser.encryptionKey,
            //   credits: newUser.credits,
            reportCount: newUser.reportCount,
            isBanned: newUser.isBanned,
            banReason: newUser.banReason,
            banDate: formatDateTimeForMySQL(newUser.banDate),
            banDuration: newUser.banDuration,
            createdAt: newUser.createdAt,
            updatedAt: newUser.updatedAt,
            passwordHash: newUser.passwordHash,
            twoFactorEnabled: newUser.twoFactorEnabled,
            twoFactorSecret: newUser.twoFactorSecret,
            recoveryCodes: JSON.stringify(newUser.recoveryCodes),
            //   profilePicture: newUser.profilePicture,
            //   bio: newUser.bio,
            //   socialLinks: JSON.stringify(newUser.socialLinks),

        };

        const { sql, values } = buildInsert('userData', insertData);
        await knex.raw(sql, values);

        sendAccountVerificationEmail(newUser);

        // Require 2FA setup before granting full access
        const tempToken = jwt.sign(
            { id: newUser.id, email: newUser.email, stage: 'pre_2fa_setup' },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        res.status(201).json({ requires2FASetup: true, tempToken, message: 'Account created. Please set up two-factor authentication.' });


    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during registration'
        });
    }
});


// ─── 2FA helpers ────────────────────────────────────────────────────────────

// ── Auth cookie helpers ───────────────────────────────────────────────────
// The httpOnly cookie lets the Express server-side page guard read the JWT
// without JavaScript, closing the client-side guard bypass.
const AUTH_COOKIE_OPTS = {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
    path:     '/',
};

function sendAuthResponse(res, authResponse, extra = {}) {
    if (authResponse?.token) res.cookie('fb_token', authResponse.token, AUTH_COOKIE_OPTS);
    res.json({ ...authResponse, ...extra });
}

async function buildFullAuthResponse(userId) {
    const [user] = await knex('userData').where('id', userId).select('*');
    if (!user) throw new Error('User not found');

    //   const btcRate = await fetchCryptoRate('BTC') || 45000;
    //   const ethRate = await fetchCryptoRate('ETH') || 3000;
    //   const ltcRate = await fetchCryptoRate('LTC') || 100;
    //   const solRate = await fetchCryptoRate('SOL') || 150;

    const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, accountType: user.accountType },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return {
        token,
        tokenExpiry: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        user: { id: user.id, username: user.username, email: user.email, accountType: user.accountType },
        accountType: user.accountType,
        message: 'Login successful',
        verification: {
            verified: false,
            amount1: user.amount1,
            amount2: user.amount2,
            //   cryptoAmounts: {
            //     BTC: { amount1: (user.amount1 / btcRate).toFixed(8), amount2: (user.amount2 / btcRate).toFixed(8) },
            //     ETH: { amount1: (user.amount1 / ethRate).toFixed(8), amount2: (user.amount2 / ethRate).toFixed(8) },
            //     LTC: { amount1: (user.amount1 / ltcRate).toFixed(8), amount2: (user.amount2 / ltcRate).toFixed(8) },
            //     SOL: { amount1: (user.amount1 / solRate).toFixed(8), amount2: (user.amount2 / solRate).toFixed(8) },
            //   },
            time: Date.now(),
        },
    };
}

function verifyTempToken(token, expectedStage) {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.stage !== expectedStage) throw new Error('Invalid token stage');
    return payload;
}

// Step 1 of setup: generate TOTP secret and QR code
server.post(PROXY + '/api/auth/2fa/setup', async (req, res) => {
    try {
        const { tempToken } = req.body;
        let payload;
        try {
            payload = verifyTempToken(tempToken, 'pre_2fa_setup');
        } catch {
            return res.status(401).json({ success: false, message: 'Invalid or expired setup token' });
        }

        const [user] = await knex('userData').where('id', payload.id).select('id', 'email');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const secret = authenticator.generateSecret();
        const otpauthUrl = authenticator.keyuri(user.email, 'Drauwper', secret);
        const qrUrl = await QRCode.toDataURL(otpauthUrl);

        // Embed secret in a fresh short-lived token so the client can send it back
        const newTempToken = jwt.sign(
            { id: user.id, email: user.email, stage: 'pre_2fa_setup', secret },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        res.json({ success: true, qrUrl, secret, tempToken: newTempToken });
    } catch (error) {
        console.error('2FA setup error:', error);
        res.status(500).json({ success: false, message: 'Server error during 2FA setup' });
    }
});

// Step 2 of setup: confirm first OTP, persist secret, return full JWT + recovery codes
server.post(PROXY + '/api/auth/2fa/enable', async (req, res) => {
    try {
        const { tempToken, code } = req.body;
        if (!tempToken || !code) {
            return res.status(400).json({ success: false, message: 'tempToken and code are required' });
        }

        let payload;
        try {
            payload = jwt.verify(tempToken, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }

        if (payload.stage !== 'pre_2fa_setup' || !payload.secret) {
            return res.status(400).json({ success: false, message: 'Call /api/auth/2fa/setup first' });
        }

        if (!authenticator.verify({ token: String(code), secret: payload.secret })) {
            return res.status(400).json({ success: false, message: 'Invalid authenticator code' });
        }

        // Generate 8 one-time recovery codes
        const recoveryCodes = Array.from({ length: 8 }, () =>
            [
                crypto.randomBytes(2).toString('hex'),
                crypto.randomBytes(2).toString('hex'),
                crypto.randomBytes(2).toString('hex'),
                crypto.randomBytes(2).toString('hex'),
            ].join('-').toUpperCase()
        );

        await knex('userData').where('id', payload.id).update({
            twoFactorEnabled: true,
            twoFactorSecret: payload.secret,
            recoveryCodes: JSON.stringify(recoveryCodes),
        });

        const authResponse = await buildFullAuthResponse(payload.id);
        sendAuthResponse(res, authResponse, { recoveryCodes, message: '2FA enabled successfully' });
    } catch (error) {
        console.error('2FA enable error:', error);
        res.status(500).json({ success: false, message: 'Server error during 2FA enable' });
    }
});

// Login step 2: verify TOTP and return full JWT
server.post(PROXY + '/api/auth/2fa/verify', async (req, res) => {
    try {
        const { tempToken, code } = req.body;
        if (!tempToken || !code) {
            return res.status(400).json({ success: false, message: 'tempToken and code are required' });
        }

        let payload;
        try {
            payload = verifyTempToken(tempToken, 'pre_2fa');
        } catch {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }

        const [user] = await knex('userData').where('id', payload.id).select('twoFactorSecret', 'twoFactorEnabled');
        if (!user || !user.twoFactorEnabled) {
            return res.status(400).json({ success: false, message: '2FA is not enabled for this account' });
        }

        if (!authenticator.verify({ token: String(code), secret: user.twoFactorSecret })) {
            return res.status(400).json({ success: false, message: 'Invalid authenticator code' });
        }

        const authResponse = await buildFullAuthResponse(payload.id);
        sendAuthResponse(res, authResponse);
    } catch (error) {
        console.error('2FA verify error:', error);
        res.status(500).json({ success: false, message: 'Server error during 2FA verification' });
    }
});

// Login step 2 (fallback): use a recovery code
server.post(PROXY + '/api/auth/2fa/recover', async (req, res) => {
    try {
        const { tempToken, recoveryCode } = req.body;
        if (!tempToken || !recoveryCode) {
            return res.status(400).json({ success: false, message: 'tempToken and recoveryCode are required' });
        }

        let payload;
        try {
            payload = verifyTempToken(tempToken, 'pre_2fa');
        } catch {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }

        const [user] = await knex('userData').where('id', payload.id).select('recoveryCodes');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        let codes = [];
        try {
            codes = typeof user.recoveryCodes === 'string'
                ? JSON.parse(user.recoveryCodes)
                : (Array.isArray(user.recoveryCodes) ? user.recoveryCodes : []);
        } catch { codes = []; }

        const normalized = recoveryCode.trim().toUpperCase();
        const idx = codes.indexOf(normalized);
        if (idx === -1) {
            return res.status(400).json({ success: false, message: 'Invalid recovery code' });
        }

        codes.splice(idx, 1); // consume the code
        await knex('userData').where('id', payload.id).update({ recoveryCodes: JSON.stringify(codes) });

        const authResponse = await buildFullAuthResponse(payload.id);
        sendAuthResponse(res, authResponse);
    } catch (error) {
        console.error('2FA recover error:', error);
        res.status(500).json({ success: false, message: 'Server error during recovery' });
    }
});


// Custom forgot password route
server.post(PROXY + '/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const users = await knex('userData')
            .where('email', email)
            .select('*');

        const user = users[0];

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User with this email does not exist'
            });
        }

        await sendPasswordResetEmail(user);

        res.json({
            success: true,
            message: 'Password reset email sent if the account exists'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during password reset'
        });
    }
});

// const response = await api.post('/api/auth/reset-password', {
//   email,
//   resetCode,
//   newPassword
// });

// if (response.data.success) {
//   setSuccess(true);
//   // Redirect to login after 2 seconds
//   setTimeout(() => {
//     navigate('/login');
//   }, 2000);
// } else {
//   setError(response.data.message || 'Failed to reset password.');
// }

// reset password route submission
server.post(PROXY + '/api/auth/reset-password', async (req, res) => {
    try {
        const { email, resetCode, newPassword } = req.body;
        if (!email || !resetCode || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Email, reset code, and new password are required'
            });
        }

        const usersReset = await knex('userData')
            .where('email', email)
            .select('*');

        const userReset = usersReset[0];

        if (!userReset) {
            return res.status(404).json({
                success: false,
                message: 'User with this email does not exist'
            });
        }

        await ensurePasswordResetTable();

        const rows = await knex('passwordResets')
            .where({ email, code: resetCode })
            .select('id', 'expiresAt', 'used')
            .orderBy('createdAt', 'desc')
            .limit(1);

        if (!rows.length) {
            return res.status(400).json({
                success: false,
                message: 'Invalid reset code'
            });
        }

        const record = rows[0];
        if (record.used) {
            return res.status(400).json({
                success: false,
                message: 'This reset code has already been used'
            });
        }

        if (new Date(record.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({
                success: false,
                message: 'Reset code has expired'
            });
        }

        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(newPassword, saltRounds);

        await knex('userData')
            .where('email', email)
            .update({ passwordHash });

        await knex('passwordResets').where('id', record.id).update({ used: 1 });

        res.json({
            success: true,
            message: 'Password has been reset successfully'
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during password reset'
        });
    }
});


server.post(PROXY + '/api/auth/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const users = await knex('userData')
            .where('email', email)
            .select('*');

        const user = users[0];

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User with this email does not exist'
            });
        }

        await sendAccountVerificationEmail(user);

        return res.json({
            success: true,
            message: 'A new verification code has been sent'
        });
    } catch (error) {
        console.error('Resend verification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error occurred while resending the verification code'
        });
    }
});

// Custom email verification route
server.post(PROXY + '/api/auth/verify-email', async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({
                success: false,
                message: 'Email and verification code are required'
            });
        }

        await ensureEmailVerificationTable();

        const rows = await knex('emailVerifications')
            .where({ email, code })
            .select('id', 'expiresAt', 'used')
            .orderBy('createdAt', 'desc')
            .limit(1);

        if (!rows.length) {
            return res.status(400).json({
                success: false,
                message: 'Invalid verification code'
            });
        }

        const record = rows[0];
        if (record.used) {
            return res.status(400).json({
                success: false,
                message: 'Verification code has already been used'
            });
        }

        if (new Date(record.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({
                success: false,
                message: 'Verification code has expired'
            });
        }

        await knex('emailVerifications').where('id', record.id).update({ used: 1 });
        // verification column removed — email ownership is confirmed by the code match above

        return res.json({
            success: true,
            message: 'Email verified successfully'
        });
    } catch (error) {
        console.error('Email verification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error occurred during email verification'
        });
    }
});

// Custom logout route
server.post(PROXY + '/api/auth/logout', async (req, res) => {
    try {
        const { username } = req.body;

        if (username) {
            // Update login status in database
            await knex('userData')
                .where('username', username)
                .update({ loginStatus: false });
        }

        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during logout'
        });
    }
});


const ensureVerificationReviewColumns = async () => {
  const [cols] = await knex.raw(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'userData'
       AND COLUMN_NAME IN (
         'verificationFacePath',
         'verificationIdPath',
         'verificationDocsStatus',
         'verificationDocsNotes',
         'verificationDocsReviewedAt',
         'verificationDocsReviewedBy'
       )`
  );

  const existing = new Set((cols || []).map((col) => col.COLUMN_NAME));
  const alters = [];

  if (!existing.has('verificationFacePath')) alters.push('ADD COLUMN verificationFacePath VARCHAR(255) DEFAULT NULL');
  if (!existing.has('verificationIdPath')) alters.push('ADD COLUMN verificationIdPath VARCHAR(255) DEFAULT NULL');
  if (!existing.has('verificationDocsStatus')) alters.push("ADD COLUMN verificationDocsStatus VARCHAR(32) DEFAULT NULL");
  if (!existing.has('verificationDocsNotes')) alters.push('ADD COLUMN verificationDocsNotes TEXT DEFAULT NULL');
  if (!existing.has('verificationDocsReviewedAt')) alters.push('ADD COLUMN verificationDocsReviewedAt DATETIME DEFAULT NULL');
  if (!existing.has('verificationDocsReviewedBy')) alters.push('ADD COLUMN verificationDocsReviewedBy VARCHAR(100) DEFAULT NULL');

  if (alters.length > 0) {
    await knex.raw(`ALTER TABLE userData ${alters.join(', ')}`);
  }
};

const createPasswordResetRecord = async (email, code) => {
  await ensurePasswordResetTable();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const createdAt = new Date();

  await knex('passwordResets').where('email', email).del();
  await knex('passwordResets').insert({
    email,
    code,
    expiresAt: formatDateTimeForMySQLLocal(expiresAt),
    createdAt: formatDateTimeForMySQLLocal(createdAt),
    used: 0
  });

  return { expiresAt };
};

async function sendAccountVerificationEmail(newUser) {
  const verificationCode = generateVerificationCode();
  const { expiresAt } = await createEmailVerificationRecord(newUser.email, verificationCode);
  const verificationLink = buildVerificationLink(newUser.email, verificationCode);

  try {
    await emailService.sendAccountVerificationEmail({
      to: newUser.email,
      username: newUser.firstName || newUser.username || "there",
      verificationLink,
      verificationCode,
      subject: 'Welcome to FaceBlurr! 🎉'
    });

    console.log(`✅ Verification email sent to ${newUser.email} (expires ${expiresAt.toISOString()})`);
  } catch (emailError) {
    console.error('⚠️ Failed to send verification email:', emailError.message || emailError);
  }
}

const generateResetCode = () => {
  const length = Math.floor(Math.random() * 3) + 8; // 6-8 digits
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
};

async function sendPasswordResetEmail(newUser) {
  const resetCode = generateResetCode();
  const { expiresAt } = await createPasswordResetRecord(newUser.email, resetCode);

  try {
    await emailService.sendPasswordResetEmail({
      to: newUser.email,
      username: newUser.firstName || newUser.username || "there",
      resetCode,
      subject: 'Reset your FaceBlurr password'
    });

    console.log(`✅ Password reset email sent to ${newUser.email} (expires ${expiresAt.toISOString()})`);
  } catch (emailError) {
    console.error('⚠️ Failed to send password reset email:', emailError.message || emailError);
  }
}



// Email verification (code + link)
const VERIFICATION_CODE_EXPIRY_MINUTES = parseInt(process.env.VERIFICATION_CODE_EXPIRY_MINUTES, 10) || 30;

const formatDateTimeForMySQLLocal = (dateTime) => {
  if (!dateTime) return null;
  return new Date(dateTime).toISOString().slice(0, 19).replace('T', ' ');
};

const buildVerificationLink = (email, code = '') => {
  const baseUrl = (process.env.FRONTEND_URL || FRONTEND_URL || "").replace(/\/$/, "");
  const params = new URLSearchParams({ email });
  if (code) params.set('code', code);
  return `${baseUrl}/verify?${params.toString()}`;
};

const generateVerificationCode = () => {
  const length = Math.floor(Math.random() * 3) + 6; // 6-8 digits
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
};

const ensureEmailVerificationTable = async () => {
  await knex.raw(
    `CREATE TABLE IF NOT EXISTS emailVerifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(100) NOT NULL,
      code VARCHAR(10) NOT NULL,
      expiresAt DATETIME NOT NULL,
      createdAt DATETIME NOT NULL,
      used TINYINT(1) DEFAULT 0,
      INDEX idx_email (email),
      INDEX idx_expires (expiresAt)
    )`
  );
};

const createEmailVerificationRecord = async (email, code) => {
  await ensureEmailVerificationTable();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MINUTES * 60 * 1000);
  const createdAt = new Date();

  await knex('emailVerifications').where('email', email).del();
  await knex('emailVerifications').insert({
    email,
    code,
    expiresAt: formatDateTimeForMySQLLocal(expiresAt),
    createdAt: formatDateTimeForMySQLLocal(createdAt),
    used: 0
  });

  return { expiresAt };
};

const ensurePasswordResetTable = async () => {
  await knex.raw(
    `CREATE TABLE IF NOT EXISTS passwordResets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(100) NOT NULL,
      code VARCHAR(10) NOT NULL,
      expiresAt DATETIME NOT NULL,
      createdAt DATETIME NOT NULL,
      used TINYINT(1) DEFAULT 0,
      INDEX idx_email (email),
      INDEX idx_expires (expiresAt)
    )`
  );
};



// Feedback route



// CREATE TABLE
//   `feedback` (
//     `id` int unsigned NOT NULL AUTO_INCREMENT,
//     `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
//     `title` varchar(255) DEFAULT NULL,
//     `message` text,
//     `contactInfo` varchar(255) DEFAULT NULL,
//     `username` varchar(255) DEFAULT NULL,
//     `feedbackType` varchar(255) DEFAULT NULL,
//     PRIMARY KEY (`id`)
//   ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci

// Custom logout route
server.post(PROXY + '/api/site-dev-feedback', async (req, res) => {
    try {
        const {
            supportProblemType,
            supportTitle,
            supportMessage,
            supportContactInfo,
            supportUsername,
            supportUserId,
            supportTargetType,
            supportTargetId,
            supportTargetUsername,
        } = req.body;



        // console.log("Received feedback:", { supportUsername, supportMessage, supportTitle, supportContactInfo, supportProblemType });

        if (supportUsername) {
            // Update login status in database
            await knex('feedback').insert({
                username: supportUsername,
                message: supportMessage,
                title: supportTitle,
                contactInfo: supportContactInfo,
                feedbackType: supportProblemType
            });

            if (
                String(supportProblemType || '').trim() === 'report-scammer' &&
                String(supportUserId || '').trim() &&
                String(supportTargetType || '').trim() === 'user' &&
                String(supportTargetId || '').trim()
            ) {
                await knex.raw(`
          CREATE TABLE IF NOT EXISTS reports (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            reporterId VARCHAR(10) NOT NULL,
            targetType ENUM('user','drop','review','comment') NOT NULL,
            targetId VARCHAR(36) NOT NULL,
            type ENUM('spam','abuse','copyright','fraud','inappropriate','other') NOT NULL,
            description TEXT,
            status ENUM('pending','reviewed','resolved','dismissed') DEFAULT 'pending',
            moderatorNote TEXT,
            resolvedAt DATETIME DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_reporterId (reporterId),
            KEY idx_targetType_targetId (targetType, targetId),
            KEY idx_status (status)
          ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci
        `);

                const reportDescription = [
                    supportTitle ? `Title: ${supportTitle}` : '',
                    supportTargetUsername ? `Target Username: ${supportTargetUsername}` : '',
                    supportMessage ? `Report Details:\n${supportMessage}` : '',
                    supportContactInfo ? `Contact: ${supportContactInfo}` : '',
                ].filter(Boolean).join('\n\n');

                const existingReport = await knex('reports')
                    .where({
                        reporterId: String(supportUserId).trim(),
                        targetType: 'user',
                        targetId: String(supportTargetId).trim(),
                        status: 'pending',
                    })
                    .first();

                if (!existingReport) {
                    await knex('reports').insert({
                        reporterId: String(supportUserId).trim(),
                        targetType: 'user',
                        targetId: String(supportTargetId).trim(),
                        type: 'fraud',
                        description: reportDescription,
                        status: 'pending',
                    });

                    await knex('userData')
                        .where('id', String(supportTargetId).trim())
                        .increment('reportCount', 1)
                        .catch(() => { });
                }
            }
        }

        res.json({
            success: true,
            message: 'Feedback submitted successfully'
        });
    } catch (error) {
        console.error('Feedback error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error occurred during feedback submission'
        });
    }
});


// ///////////////////////////////
// in app notification routes
// /////////////////////////

// ============================================================
//  NOTIFICATIONS
// ============================================================

/** GET /api/notifications/me — paginated, newest first */
server.get(PROXY + '/api/notifications/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(50, +(req.query.limit || 20));
        const [rows] = await pool.query(
            `SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT ?`,
            [userId, limit]
        );
        const unreadCount = rows.filter((r) => !r.isRead).length;
        res.json({ notifications: rows, unreadCount });
    } catch (err) {
        console.error('GET /api/notifications/me error:', err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

/** PATCH /api/notifications/read-all — mark all as read */
server.patch(PROXY + '/api/notifications/read-all', authenticateToken, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET isRead = 1 WHERE userId = ?', [req.user.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark all read' });
    }
});

/** PATCH /api/notifications/:id/read — mark one as read */
server.patch(PROXY + '/api/notifications/:id/read', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?',
            [req.params.id, req.user.id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to mark read' });
    }
});

/** DELETE /api/notifications/:id — delete a single notification */
server.delete(PROXY + '/api/notifications/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM notifications WHERE id = ? AND userId = ?',
            [req.params.id, req.user.id]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

// function to create a notification may not be needed in routes, can be used in any server logic that wants to create a notification for a user. For example, after a successful purchase, or when a new drop from a followed creator is available, etc.

// CREATE TABLE
//   `notifications` (
//     `id` varchar(10) NOT NULL,
//     `type` varchar(50) DEFAULT NULL,
//     `title` varchar(255) DEFAULT NULL,
//     `message` text,
//     `createdAt` datetime DEFAULT NULL,
//     `priority` enum('success', 'info', 'warning', 'error') DEFAULT 'info',
//     `category` enum('buyer', 'seller') NOT NULL,
//     `username` varchar(50) DEFAULT NULL,
//     `isRead` tinyint(1) DEFAULT '0',
//     PRIMARY KEY (`id`),
//     KEY `username` (`username`),
//     CONSTRAINT `notifications_ibfk_1` FOREIGN KEY (`username`) REFERENCES `userData` (`username`) ON DELETE CASCADE
//   ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci

async function CreateNotification(type, title, message, category, username, priority = 'info') {
  const id = Math.random().toString(36).substring(2, 12).toUpperCase();
  const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const rawCategory = String(category || '').toLowerCase().trim();
  const sellerCategoryHints = new Set(['seller', 'creator', 'payout', 'earnings']);
  const safeCategory = sellerCategoryHints.has(rawCategory) ? 'seller' : 'buyer';

  const rawPriority = String(priority || '').toLowerCase().trim();
  const allowedPriorities = new Set(['success', 'info', 'warning', 'error']);
  const safePriority = allowedPriorities.has(rawPriority) ? rawPriority : 'info';

  await knex('notifications').insert({
    userId,
    type,
    title,
    message,
    createdAt,
    priority: safePriority,
    category: safeCategory,
    username,
    isRead: 0
  });

  return { id, type, title, message, createdAt, priority: safePriority, category: safeCategory, username, isRead: 0 };
}


// ========================================
// Stripe Subscription Endpoints
// ========================================

// const FRONTEND_URL = 'http://localhost:5174';


server.post('/create-checkout-session', async (req, res) => {
    const amount = req.body.amount
    const priceId = req.body.priceId; // Replace with your actual Price ID

    // console.log("req.body: ", req.body)

    console.log("amount: ", amount)
    console.log("priceId: ", priceId)

    try {
        const session = await stripe.checkout.sessions.create({
            ui_mode: 'embedded',
            mode: 'payment',
            line_items: [
                {
                    // Provide the exact Price ID (for example, pr_1234) of the product you want to sell
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: `${FRONTEND_URL}/return?session_id={CHECKOUT_SESSION_ID}&amount=${amount}`,
            cancel_url: `${FRONTEND_URL}/cancel`,

            // return_url: `${FRONTEND_URL}/return?session_id={CHECKOUT_SESSION_ID}&amount=${amount}`,
        });

        // Return a single response with the checkout URL (frontend should redirect user to this URL)
        res.status(200).json({ url: session.url, sessionId: session.id });
    } catch (error) {
        console.error('Create checkout session error:', error);
        res.status(500).json({ error: "Checkout failed." });
    }
});


server.get('/session-status', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);

        // The paymentIntent ID is usually stored in session.payment_intent
        const paymentIntentId = session.payment_intent;

        // Retrieve PaymentIntent for more details, including total amounts & breakdown
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        console.log("PyINT: ", paymentIntent)

        // Extract any relevant data, e.g. charges, amount received, etc.
        // const charge = paymentIntent.charges.data[0]; // If only 1 charge
        const amountReceived = paymentIntent.amount; // in cents
        const receiptUrl = paymentIntent.receipt_url;
        const createAt = paymentIntent.created;
        const clientSecret = paymentIntent.clientSecret;
        const paymentID = paymentIntent.id;
        const paymentStatus = paymentIntent.paymentStatus;

        res.json({
            session,
            paymentIntent,
            status: session.status,
            customer_email: session.customer_details.email,
            receipt_url: receiptUrl,
            amount_received_cents: amountReceived,
            created: createAt,
            clientSecret: clientSecret,
            paymentID: paymentID,
            paymentStatus: paymentStatus,
            // ...any other data you need
        });

    } catch (error) {
        console.log("Error retrieving session status:", error);
        res.status(500).send("Error retrieving session status");
    }
});


// Create subscription checkout session
server.post(PROXY + '/api/subscription/create-checkout', async (req, res) => {
    try {
        const {
            userId,
            username,
            email,
            priceId,
            planId,
            planName,
            successUrl,
            cancelUrl
        } = req.body;

        // Resolve priceId from planId when not explicitly provided
        const PLAN_PRICE_MAP = {
            pro:      process.env.STRIPE_PRICE_PRO,
            advanced: process.env.STRIPE_PRICE_ADVANCED,
        };
        const resolvedPriceId = priceId || (planId ? PLAN_PRICE_MAP[planId] : null);

        if (!userId || !email || !resolvedPriceId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields (userId, email, and planId or priceId are required)'
            });
        }

        // Check if user already has a subscription
        const existingSubs = await knex('subscriptions')
            .where({ user_id: userId, status: 'active' })
            .select('*');

        if (existingSubs.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User already has an active subscription'
            });
        }

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: resolvedPriceId,
                    quantity: 1,
                },
            ],
            customer_email: email,
            client_reference_id: userId.toString(),
            metadata: {
                userId: userId.toString(),
                username: username,
                planId: planId,
                planName: planName
            },
            success_url: successUrl,
            cancel_url: cancelUrl,
            subscription_data: {
                metadata: {
                    userId: userId.toString(),
                    username: username,
                    planId: planId,
                    planName: planName
                }
            }
        });

        console.log(`✅ Created checkout session for user ${userId}: ${session.id}`);

        res.json({
            success: true,
            sessionId: session.id,
            url: session.url
        });
    } catch (error) {
        console.error('Create checkout error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create checkout session'
        });
    }
});

// ── Upgrade / downgrade an existing subscription ──────────────────────────
server.post(PROXY + '/api/subscription/upgrade', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { planId, planName } = req.body;

        const PLAN_PRICE_MAP = {
            pro:      process.env.STRIPE_PRICE_PRO,
            advanced: process.env.STRIPE_PRICE_ADVANCED,
        };
        const newPriceId = PLAN_PRICE_MAP[planId];
        if (!newPriceId) {
            return res.status(400).json({ success: false, message: 'Invalid plan' });
        }

        const existingSub = await knex('subscriptions')
            .where({ user_id: userId })
            .whereIn('status', ['active', 'trialing'])
            .orderBy('created_at', 'desc')
            .first();

        if (!existingSub) {
            return res.status(400).json({ success: false, message: 'No active subscription found to upgrade' });
        }

        // Retrieve live subscription from Stripe to get the current item id
        const stripeSub = await stripe.subscriptions.retrieve(existingSub.stripe_subscription_id);
        const itemId = stripeSub.items.data[0]?.id;
        if (!itemId) {
            return res.status(500).json({ success: false, message: 'Could not locate subscription item in Stripe' });
        }

        // Update the subscription to the new price (proration applied automatically)
        const updated = await stripe.subscriptions.update(existingSub.stripe_subscription_id, {
            items: [{ id: itemId, price: newPriceId }],
            proration_behavior: 'create_prorations',
            metadata: { planId, planName: planName || planId },
        });

        const resolvedPlanName = planName || (planId.charAt(0).toUpperCase() + planId.slice(1));

        // Sync DB
        await knex('subscriptions')
            .where({ stripe_subscription_id: existingSub.stripe_subscription_id })
            .update({
                plan_id:              planId,
                plan_name:            resolvedPlanName,
                status:               updated.status,
                current_period_start: new Date(updated.current_period_start * 1000),
                current_period_end:   new Date(updated.current_period_end   * 1000),
                updated_at:           new Date(),
            });

        await knex('userData').where({ id: userId }).update({ accountType: planId });

        console.log(`✅ Subscription upgraded: user=${userId} → plan=${planId}`);

        res.json({ success: true, planId, planName: resolvedPlanName, status: updated.status });
    } catch (error) {
        console.error('Upgrade subscription error:', error);
        res.status(500).json({ success: false, message: 'Failed to upgrade subscription' });
    }
});

// ── Plans catalogue (public) ──────────────────────────────────────────────
server.get(PROXY + '/api/subscription/plans', (req, res) => {
    res.json({
        plans: [
            {
                id: 'free',
                name: 'Free',
                price: 0,
                currency: 'usd',
                interval: 'month',
                description: 'Get started with AI face blurring at no cost.',
                features: [
                    'AI auto face blur',
                    'Up to 75% output resolution',
                    '1 face detected at a time',
                    'Click blur (limited)',
                ],
            },
            {
                id: 'pro',
                name: 'Pro',
                price: 2.99,
                currency: 'usd',
                interval: 'month',
                description: 'Full resolution and multi-face detection for serious creators.',
                features: [
                    'Everything in Free',
                    'Full original resolution output',
                    'Up to 3 faces at once',
                    'Faster detection (150ms+)',
                    'Full click blur controls',
                ],
            },
            {
                id: 'advanced',
                name: 'Advanced',
                price: 4.99,
                currency: 'usd',
                interval: 'month',
                description: 'Manual-only mode, zero AI overhead, maximum control.',
                features: [
                    'Everything in Pro',
                    'Manual-only click blur mode',
                    'No AI inference overhead',
                    'Optimised memory usage',
                ],
            },
        ],
    });
});

// ── Subscription status for current user ───────────────────────────────────
server.get(PROXY + '/api/subscription/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const [user] = await knex('userData')
            .where({ id: userId })
            .select('accountType', 'planExpiry');

        const activeSub = await knex('subscriptions')
            .where({ user_id: userId })
            .whereIn('status', ['active', 'trialing'])
            .orderBy('created_at', 'desc')
            .first();

        res.json({
            success:     true,
            accountType: user?.accountType || 'free',
            planExpiry:  user?.planExpiry  || null,
            subscription: activeSub || null,
        });
    } catch (err) {
        console.error('Subscription status error:', err);
        res.status(500).json({ success: false, message: 'Error fetching subscription status' });
    }
});

// ── Refresh JWT with latest accountType (called after payment) ─────────────
server.post(PROXY + '/api/auth/refresh-token', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const [user] = await knex('userData')
            .where({ id: userId })
            .select('id', 'email', 'username', 'accountType');

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const token = jwt.sign(
            { id: user.id, email: user.email, username: user.username, accountType: user.accountType },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        res.cookie('fb_token', token, AUTH_COOKIE_OPTS);
        res.json({
            success:     true,
            token,
            accountType: user.accountType,
            user: { id: user.id, username: user.username, email: user.email, accountType: user.accountType },
        });
    } catch (err) {
        console.error('Refresh token error:', err);
        res.status(500).json({ success: false, message: 'Error refreshing token' });
    }
});

// Verify subscription session
server.get(PROXY + '/api/subscription/verify-session', async (req, res) => {
    try {
        const { session_id } = req.query;

        if (!session_id) {
            return res.status(400).json({
                success: false,
                message: 'Session ID is required'
            });
        }

        // Retrieve session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id, {
            expand: ['subscription', 'customer']
        });

        // For subscriptions Stripe may return payment_status='no_payment_required' on free trials,
        // so check session.status === 'complete' as the authoritative gate instead.
        if ((session.status === 'complete' || session.payment_status === 'paid') && session.subscription) {
            const subscription = session.subscription;

            // client_reference_id may be "userId_planId" (payment link flow) or plain userId
            const clientRef = session.client_reference_id || '';
            const underscoreIdx = clientRef.lastIndexOf('_');
            let userId, planId;
            if (underscoreIdx > 0) {
                userId = clientRef.substring(0, underscoreIdx);
                planId = clientRef.substring(underscoreIdx + 1);
            } else {
                userId = clientRef;
                planId = null;
            }
            // Fall back to session metadata if present (server-created checkout sessions)
            userId = session.metadata?.userId || userId;
            planId = session.metadata?.planId || planId || 'standard';
            const planName = session.metadata?.planName || (planId.charAt(0).toUpperCase() + planId.slice(1));

            // Save subscription to database
            await knex.raw(
                `INSERT INTO subscriptions 
         (user_id, stripe_subscription_id, stripe_customer_id, plan_id, plan_name, 
          status, current_period_start, current_period_end, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
         stripe_subscription_id = VALUES(stripe_subscription_id),
         status = VALUES(status),
         current_period_start = VALUES(current_period_start),
         current_period_end = VALUES(current_period_end)`,
                [
                    userId,
                    subscription.id,
                    session.customer.id || session.customer,
                    planId,
                    planName,
                    subscription.status,
                    new Date(subscription.current_period_start * 1000),
                    new Date(subscription.current_period_end * 1000),
                    new Date()
                ]
            );

            // Update the user's account type to reflect the new plan
            await knex('userData').where({ id: userId }).update({ accountType: planId });

            console.log(`✅ Subscription activated for user ${userId}: plan=${planId}`);

            res.json({
                success: true,
                session: {
                    amount_total: session.amount_total,
                    customer_email: session.customer_details?.email || session.customer_email,
                    subscription: {
                        id: subscription.id,
                        planId: planId,
                        planName: planName,
                        interval: subscription.items.data[0]?.plan.interval,
                        current_period_end: subscription.current_period_end,
                        status: subscription.status
                    }
                }
            });
        } else {
            res.json({
                success: false,
                message: 'Payment not completed'
            });
        }
    } catch (error) {
        console.error('Verify session error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify session'
        });
    }
});

// Get current subscription
server.get(PROXY + '/api/subscription/current/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const subscriptions = await knex('subscriptions')
            .where('user_id', userId)
            .whereIn('status', ['active', 'trialing'])
            .orderBy('created_at', 'desc')
            .limit(1);

        if (subscriptions.length > 0) {
            res.json({
                success: true,
                subscription: subscriptions[0]
            });
        } else {
            res.json({
                success: true,
                subscription: null
            });
        }
    } catch (error) {
        console.error('Get subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Database error'
        });
    }
});

// Create customer portal session
server.post(PROXY + '/api/subscription/portal', async (req, res) => {
    try {
        const { userId, returnUrl } = req.body;

        // Get user's subscription
        const subscriptions = await knex('subscriptions')
            .where({ user_id: userId, status: 'active' })
            .select('stripe_customer_id');

        if (subscriptions.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active subscription found'
            });
        }

        const customerId = subscriptions[0].stripe_customer_id;

        // Create portal session
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        res.json({
            success: true,
            url: session.url
        });
    } catch (error) {
        console.error('Portal error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create portal session'
        });
    }
});

// Cancel subscription
server.post(PROXY + '/api/subscription/cancel', async (req, res) => {
    try {
        const { userId } = req.body;

        // Get user's subscription
        const subscriptions = await knex('subscriptions')
            .where({ user_id: userId, status: 'active' })
            .select('stripe_subscription_id');

        if (subscriptions.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active subscription found'
            });
        }

        const subscriptionId = subscriptions[0].stripe_subscription_id;

        // Cancel at period end (don't cancel immediately)
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true
        });

        // Update database
        await knex('subscriptions')
            .where('user_id', userId)
            .update({ status: 'canceling' });

        console.log(`✅ Subscription cancelled for user ${userId}`);

        res.json({
            success: true,
            message: 'Subscription will be cancelled at the end of the billing period'
        });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel subscription'
        });
    }
});

// unnecessaryHelper functions handle Stripe Subscriptions

async function ensureStripeTransactionsTable() {
    await knex.raw(`
    CREATE TABLE IF NOT EXISTS stripeTransactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      stripeObjectType VARCHAR(50) DEFAULT 'payment_intent',
      stripeBalanceTransactionId VARCHAR(255) DEFAULT NULL,
      stripePaymentIntentId VARCHAR(255) DEFAULT NULL,
      stripeChargeId VARCHAR(255) DEFAULT NULL,
      stripeCheckoutSessionId VARCHAR(255) DEFAULT NULL,
      stripeCustomerId VARCHAR(255) DEFAULT NULL,
      stripeInvoiceId VARCHAR(255) DEFAULT NULL,
      stripeSubscriptionId VARCHAR(255) DEFAULT NULL,
      stripeSourceId VARCHAR(255) DEFAULT NULL,
      stripeSourceType VARCHAR(50) DEFAULT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'unknown',
      amount INT NOT NULL DEFAULT 0,
      amountReceived INT NOT NULL DEFAULT 0,
      fee INT NOT NULL DEFAULT 0,
      net INT NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      paymentMethodTypes JSON DEFAULT NULL,
      description TEXT,
      receiptEmail VARCHAR(255) DEFAULT NULL,
      customerEmail VARCHAR(255) DEFAULT NULL,
      customerName VARCHAR(255) DEFAULT NULL,
      livemode TINYINT(1) NOT NULL DEFAULT 0,
      metadata JSON DEFAULT NULL,
      rawPayload JSON DEFAULT NULL,
      stripeCreatedAt DATETIME DEFAULT NULL,
      availableOn DATETIME DEFAULT NULL,
      syncedAt DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_stripe_payment_intent (stripePaymentIntentId),
      UNIQUE KEY uq_stripe_charge (stripeChargeId),
      UNIQUE KEY uq_stripe_balance_txn (stripeBalanceTransactionId),
      KEY idx_stripe_customer (stripeCustomerId),
      KEY idx_stripe_status (status),
      KEY idx_stripe_created_at (stripeCreatedAt),
      KEY idx_stripe_source_id (stripeSourceId),
      KEY idx_stripe_object_type (stripeObjectType)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci
  `);

    const alterStatements = [
        "ALTER TABLE stripeTransactions MODIFY COLUMN stripePaymentIntentId VARCHAR(255) NULL",
        "ALTER TABLE stripeTransactions MODIFY COLUMN stripeChargeId VARCHAR(255) NULL",
        "ALTER TABLE stripeTransactions ADD COLUMN stripeObjectType VARCHAR(50) DEFAULT 'payment_intent'",
        "ALTER TABLE stripeTransactions ADD COLUMN stripeBalanceTransactionId VARCHAR(255) DEFAULT NULL",
        "ALTER TABLE stripeTransactions ADD COLUMN stripeSourceId VARCHAR(255) DEFAULT NULL",
        "ALTER TABLE stripeTransactions ADD COLUMN stripeSourceType VARCHAR(50) DEFAULT NULL",
        "ALTER TABLE stripeTransactions ADD COLUMN fee INT NOT NULL DEFAULT 0",
        "ALTER TABLE stripeTransactions ADD COLUMN net INT NOT NULL DEFAULT 0",
        "ALTER TABLE stripeTransactions ADD COLUMN availableOn DATETIME DEFAULT NULL",
        "ALTER TABLE stripeTransactions ADD UNIQUE KEY uq_stripe_balance_txn (stripeBalanceTransactionId)",
        "ALTER TABLE stripeTransactions ADD KEY idx_stripe_source_id (stripeSourceId)",
        "ALTER TABLE stripeTransactions ADD KEY idx_stripe_object_type (stripeObjectType)"
    ];

    for (const sql of alterStatements) {
        try {
            await knex.raw(sql);
        } catch (error) {
            const message = error?.message || String(error);
            if (/Duplicate column name|Duplicate key name/i.test(message)) continue;
            console.warn('Stripe table alter skipped:', message);
        }
    }

    await knex('stripeTransactions')
        .where('stripeObjectType', 'payment_intent')
        .update({ stripeChargeId: null })
        .catch(() => { });
}

function normalizeStripeTransaction(paymentIntent) {
    const customer = paymentIntent?.customer && typeof paymentIntent.customer === 'object'
        ? paymentIntent.customer
        : null;
    const charge = paymentIntent?.latest_charge && typeof paymentIntent.latest_charge === 'object'
        ? paymentIntent.latest_charge
        : null;
    const billing = charge?.billing_details || {};
    const metadata = paymentIntent?.metadata || {};

    return {
        stripeObjectType: 'payment_intent',
        stripeBalanceTransactionId: null,
        stripePaymentIntentId: paymentIntent.id,
        stripeChargeId: null,
        stripeCheckoutSessionId: metadata.checkout_session_id || metadata.checkoutSessionId || metadata.session_id || null,
        stripeCustomerId: customer?.id || (typeof paymentIntent.customer === 'string' ? paymentIntent.customer : null),
        stripeInvoiceId: typeof paymentIntent.invoice === 'string' ? paymentIntent.invoice : paymentIntent.invoice?.id || null,
        stripeSubscriptionId: metadata.subscription_id || metadata.stripe_subscription_id || metadata.subscriptionId || null,
        stripeSourceId: paymentIntent.id,
        stripeSourceType: 'payment_intent',
        status: paymentIntent.status || 'unknown',
        amount: Number(paymentIntent.amount || 0),
        amountReceived: Number(paymentIntent.amount_received || 0),
        fee: 0,
        net: Number(paymentIntent.amount_received || paymentIntent.amount || 0),
        currency: String(paymentIntent.currency || 'USD').toUpperCase(),
        paymentMethodTypes: JSON.stringify(paymentIntent.payment_method_types || []),
        description: paymentIntent.description || null,
        receiptEmail: paymentIntent.receipt_email || null,
        customerEmail: customer?.email || billing.email || null,
        customerName: customer?.name || billing.name || null,
        livemode: paymentIntent.livemode ? 1 : 0,
        metadata: JSON.stringify(metadata),
        rawPayload: JSON.stringify(paymentIntent),
        stripeCreatedAt: toMySQLDateTime(paymentIntent.created),
        availableOn: null,
        syncedAt: toMySQLDateTime(Date.now()),
    };
}

function normalizeStripeBalanceTransaction(balanceTx) {
    const source = balanceTx?.source && typeof balanceTx.source === 'object'
        ? balanceTx.source
        : null;
    const billing = source?.billing_details || {};
    const sourceMetadata = source?.metadata || {};

    return {
        stripeObjectType: 'balance_transaction',
        stripeBalanceTransactionId: balanceTx.id,
        stripePaymentIntentId: null,
        stripeChargeId: source?.object === 'charge' ? source.id : null,
        stripeCheckoutSessionId: sourceMetadata.checkout_session_id || sourceMetadata.checkoutSessionId || sourceMetadata.session_id || null,
        stripeCustomerId: source?.customer || null,
        stripeInvoiceId: source?.invoice || null,
        stripeSubscriptionId: sourceMetadata.subscription_id || sourceMetadata.stripe_subscription_id || sourceMetadata.subscriptionId || source?.subscription || null,
        stripeSourceId: typeof balanceTx.source === 'string' ? balanceTx.source : source?.id || null,
        stripeSourceType: source?.object || balanceTx.type || null,
        status: source?.status || balanceTx.type || 'unknown',
        amount: Number(balanceTx.amount || 0),
        amountReceived: Number(balanceTx.amount || 0),
        fee: Number(balanceTx.fee || 0),
        net: Number(balanceTx.net || 0),
        currency: String(balanceTx.currency || 'USD').toUpperCase(),
        paymentMethodTypes: JSON.stringify(source?.payment_method_details?.type ? [source.payment_method_details.type] : []),
        description: source?.description || balanceTx.description || null,
        receiptEmail: source?.receipt_email || null,
        customerEmail: billing.email || source?.customer_details?.email || null,
        customerName: billing.name || source?.customer_details?.name || null,
        livemode: balanceTx.livemode ? 1 : 0,
        metadata: JSON.stringify(sourceMetadata),
        rawPayload: JSON.stringify(balanceTx),
        stripeCreatedAt: toMySQLDateTime(balanceTx.created),
        availableOn: toMySQLDateTime(balanceTx.available_on),
        syncedAt: toMySQLDateTime(Date.now()),
    };
}

async function upsertStripeTransactionRecord(record) {
    await knex.raw(
        `INSERT INTO stripeTransactions (
      stripeObjectType, stripeBalanceTransactionId, stripePaymentIntentId, stripeChargeId,
      stripeCheckoutSessionId, stripeCustomerId, stripeInvoiceId, stripeSubscriptionId,
      stripeSourceId, stripeSourceType, status, amount, amountReceived, fee, net, currency,
      paymentMethodTypes, description, receiptEmail, customerEmail, customerName,
      livemode, metadata, rawPayload, stripeCreatedAt, availableOn, syncedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      stripeObjectType = VALUES(stripeObjectType),
      stripeChargeId = VALUES(stripeChargeId),
      stripeCheckoutSessionId = VALUES(stripeCheckoutSessionId),
      stripeCustomerId = VALUES(stripeCustomerId),
      stripeInvoiceId = VALUES(stripeInvoiceId),
      stripeSubscriptionId = VALUES(stripeSubscriptionId),
      stripeSourceId = VALUES(stripeSourceId),
      stripeSourceType = VALUES(stripeSourceType),
      status = CASE
        WHEN stripeTransactions.status IN ('pending', 'processing', 'canceled') THEN stripeTransactions.status
        ELSE VALUES(status)
      END,
      amount = VALUES(amount),
      amountReceived = VALUES(amountReceived),
      fee = VALUES(fee),
      net = VALUES(net),
      currency = VALUES(currency),
      paymentMethodTypes = VALUES(paymentMethodTypes),
      description = VALUES(description),
      receiptEmail = VALUES(receiptEmail),
      customerEmail = VALUES(customerEmail),
      customerName = VALUES(customerName),
      livemode = VALUES(livemode),
      metadata = VALUES(metadata),
      rawPayload = VALUES(rawPayload),
      stripeCreatedAt = VALUES(stripeCreatedAt),
      availableOn = VALUES(availableOn),
      syncedAt = VALUES(syncedAt),
      updated_at = CURRENT_TIMESTAMP`,
        [
            record.stripeObjectType,
            record.stripeBalanceTransactionId,
            record.stripePaymentIntentId,
            record.stripeChargeId,
            record.stripeCheckoutSessionId,
            record.stripeCustomerId,
            record.stripeInvoiceId,
            record.stripeSubscriptionId,
            record.stripeSourceId,
            record.stripeSourceType,
            record.status,
            record.amount,
            record.amountReceived,
            record.fee,
            record.net,
            record.currency,
            record.paymentMethodTypes,
            record.description,
            record.receiptEmail,
            record.customerEmail,
            record.customerName,
            record.livemode,
            record.metadata,
            record.rawPayload,
            record.stripeCreatedAt,
            record.availableOn,
            record.syncedAt,
        ]
    );
}


// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Retrieve the most recent PaymentIntents from Stripe with optional customer details
 */
async function getRecentPayments(limit = 10, includeCustomerDetails = true) {
    try {
        const paymentIntents = await stripe.paymentIntents.list({
            limit,
            expand: ['data.customer', 'data.latest_charge']
        });
        const results = [];

        for (const pi of paymentIntents.data) {
            const paymentData = {
                id: pi.id,
                status: pi.status,
                amount: pi.amount,
                currency: pi.currency,
                description: pi.description,
                created: pi.created,
                customer_id: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null,
                metadata: pi.metadata
            };

            if (includeCustomerDetails && pi.customer) {
                if (typeof pi.customer === 'object') {
                    paymentData.customer = {
                        id: pi.customer.id,
                        email: pi.customer.email,
                        name: pi.customer.name,
                        phone: pi.customer.phone,
                        metadata: pi.customer.metadata || {}
                    };
                } else {
                    const customerDetails = await getCustomerDetails(pi.customer);
                    paymentData.customer = customerDetails || null;
                }
            }

            results.push(paymentData);
        }

        console.log(`[DEBUG] Fetched ${results.length} payment intents`);
        return { success: true, count: results.length, payments: results };
    } catch (error) {
        const errorMessage = error.message || String(error);
        console.error('[ERROR] Stripe API error:', errorMessage);
        return { error: errorMessage, status: 'api_error' };
    }
}

async function getRecentCheckoutSessions({ limit = 50, timeRangeStart, timeRangeEnd } = {}) {
    const params = {
        limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
        expand: ['data.payment_intent', 'data.payment_intent.latest_charge']
    };

    const created = {};
    if (Number.isFinite(timeRangeStart)) created.gte = Math.floor(timeRangeStart / 1000);
    if (Number.isFinite(timeRangeEnd)) created.lte = Math.floor(timeRangeEnd / 1000);
    if (Object.keys(created).length > 0) params.created = created;

    return stripe.checkout.sessions.list(params);
}

async function syncStripeTransactionsCron(limit = 100) {
    if (!process.env.STRIPE_SECRET_KEY) {
        console.warn('⚠️ STRIPE_SECRET_KEY is missing. Stripe transaction sync skipped.');
        return { success: false, skipped: true, reason: 'missing_secret_key' };
    }

    await ensureStripeTransactionsTable();

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
    const lookbackHours = parseInt(process.env.STRIPE_SYNC_HOURS || '8760', 10); // default: 1 year
    const baseParams = {
        limit: safeLimit,
        expand: ['data.customer', 'data.latest_charge']
    };

    if (Number.isFinite(lookbackHours) && lookbackHours > 0) {
        const createdSinceUnix = Math.floor(Date.now() / 1000) - (lookbackHours * 60 * 60);
        baseParams.created = { gte: createdSinceUnix };
    }

    let paymentIntents = await stripe.paymentIntents.list(baseParams);

    if ((!paymentIntents?.data || paymentIntents.data.length === 0) && baseParams.created) {
        console.warn(`⚠️ Stripe sync found no payment intents in the last ${lookbackHours} hours. Falling back to the latest ${safeLimit} payment intents.`);
        const fallbackParams = { ...baseParams };
        delete fallbackParams.created;
        paymentIntents = await stripe.paymentIntents.list(fallbackParams);
    }

    const balanceTransactions = await stripe.balanceTransactions.list({
        limit: safeLimit,
        expand: ['data.source']
    });

    let inserted = 0;
    let updated = 0;

    for (const pi of paymentIntents.data || []) {
        const [existing] = await knex('stripeTransactions')
            .where('stripePaymentIntentId', pi.id)
            .select('id')
            .limit(1);

        const record = normalizeStripeTransaction(pi);
        await upsertStripeTransactionRecord(record);

        if (existing) updated += 1;
        else inserted += 1;
    }

    for (const tx of balanceTransactions.data || []) {
        const [existing] = await knex('stripeTransactions')
            .where('stripeBalanceTransactionId', tx.id)
            .select('id')
            .limit(1);

        const record = normalizeStripeBalanceTransaction(tx);
        await upsertStripeTransactionRecord(record);

        if (existing) updated += 1;
        else inserted += 1;
    }

    console.log(`💳 Stripe sync complete: ${inserted} inserted, ${updated} updated, ${(paymentIntents.data || []).length} payment intents scanned, ${(balanceTransactions.data || []).length} balance transactions scanned.`);
    return {
        success: true,
        inserted,
        updated,
        paymentIntentsScanned: (paymentIntents.data || []).length,
        balanceTransactionsScanned: (balanceTransactions.data || []).length,
        scanned: (paymentIntents.data || []).length + (balanceTransactions.data || []).length,
    };
}

// Run the sync every 30 minutes - fetches recent transactions/subscriptions and updates the database

cron.schedule('*/30 * * * *', async () => {
    try {
        await syncStripeTransactionsCron(100);
    } catch (err) {
        console.error('Stripe transaction cron error:', err.message || err);
    }
});

const STRIPE_AUTO_APPROVE_MIN_MATCH_SCORE = parseInt(process.env.STRIPE_AUTO_APPROVE_MIN_MATCH_SCORE || '2', 10);
const STRIPE_MANUAL_REVIEW_MAX_PER_DAY = parseInt(process.env.STRIPE_MANUAL_REVIEW_MAX_PER_DAY || '3', 10);
const STRIPE_MANUAL_REVIEW_MAX_PER_HOUR = parseInt(process.env.STRIPE_MANUAL_REVIEW_MAX_PER_HOUR || '1', 10);

function toCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function enforceStripeManualReviewRateLimit(userId) {
    if (!userId) return;

    const base = knex('CreditPurchases')
        .where('userId', userId)
        .where('paymentMethod', 'stripe')
        .whereIn('status', ['processing', 'pending']);

    const [hourlyRow] = await base.clone()
        .where('created_at', '>=', knex.raw('DATE_SUB(NOW(), INTERVAL 1 HOUR)'))
        .count({ count: 'id' });

    const [dailyRow] = await base.clone()
        .where('created_at', '>=', knex.raw('DATE_SUB(NOW(), INTERVAL 1 DAY)'))
        .count({ count: 'id' });

    const hourlyCount = toCount(hourlyRow?.count);
    const dailyCount = toCount(dailyRow?.count);

    if (hourlyCount >= STRIPE_MANUAL_REVIEW_MAX_PER_HOUR) {
        const err = new Error('Manual review request limit reached. You can submit only 1 manual-review Stripe request per hour.');
        err.httpStatus = 429;
        throw err;
    }

    if (dailyCount >= STRIPE_MANUAL_REVIEW_MAX_PER_DAY) {
        const err = new Error('Manual review request limit reached. You can submit up to 3 manual-review Stripe requests per day.');
        err.httpStatus = 429;
        throw err;
    }
}


/////////////////////////////////////////////////////////
//  Subscription Purchase Logging
/////////////////////////////////////////////////////////


// Get subscription data from Stripe by subscription ID or customer ID
server.get(PROXY + '/api/get-stripe-subscription', async (req, res) => {
    const { subscriptionId, customerId, email } = req.query;

    try {
        let subscription = null;

        // If subscription ID is provided, fetch that specific subscription
        if (subscriptionId) {
            console.log(`[INFO] Fetching subscription by ID: ${subscriptionId}`);

            subscription = await stripe.subscriptions.retrieve(subscriptionId, {
                expand: ['items.data.price.product', 'customer', 'latest_invoice']
            });

            return res.json({
                success: true,
                subscription: subscription
            });
        }

        // If customer ID is provided, fetch all subscriptions for that customer
        else if (customerId) {
            console.log(`[INFO] Fetching subscriptions for customer ID: ${customerId}`);

            const subscriptions = await stripe.subscriptions.list({
                customer: customerId,
                limit: 100,
                expand: ['data.items.data.price.product', 'data.customer', 'data.latest_invoice']
            });

            return res.json({
                success: true,
                subscriptions: subscriptions.data,
                count: subscriptions.data.length
            });
        }

        // If email is provided, find customer by email first, then get subscriptions
        else if (email) {
            console.log(`[INFO] Fetching subscriptions for customer email: ${email}`);

            // Search for customer by email
            const customers = await stripe.customers.list({
                email: email,
                limit: 1
            });

            if (customers.data.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'No customer found with that email',
                    status: 'not_found'
                });
            }

            const customer = customers.data[0];
            console.log(`[INFO] Found customer: ${customer.id}`);

            // Fetch subscriptions for this customer
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.id,
                limit: 100,
                expand: ['data.items.data.price.product', 'data.customer', 'data.latest_invoice']
            });

            return res.json({
                success: true,
                customer: {
                    id: customer.id,
                    email: customer.email,
                    name: customer.name
                },
                subscriptions: subscriptions.data,
                count: subscriptions.data.length
            });
        }

        // No valid identifier provided
        else {
            return res.status(400).json({
                success: false,
                error: 'Must provide subscriptionId, customerId, or email as query parameter',
                status: 'invalid_input',
                examples: {
                    bySubscriptionId: '/api/get-stripe-subscription?subscriptionId=sub_xxxxx',
                    byCustomerId: '/api/get-stripe-subscription?customerId=cus_xxxxx',
                    byEmail: '/api/get-stripe-subscription?email=user@example.com'
                }
            });
        }

    } catch (error) {
        console.error('[ERROR] Failed to fetch subscription:', error);

        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch subscription data',
            status: 'server_error',
            code: error.code
        });
    }
});


// Get all active subscriptions (for admin/monitoring)
server.get(PROXY + '/api/get-stripe-subscriptions-all', async (req, res) => {
    const { status, limit = 10, starting_after, created_since, created_hours_ago } = req.query;

    try {
        console.log(`[INFO] Fetching all subscriptions with status: ${status || 'all'}, limit: ${limit}`);

        const params = {
            limit: Math.min(parseInt(limit), 100), // Cap at 100
            expand: ['data.items.data.price.product', 'data.customer', 'data.latest_invoice']
        };

        // Filter by status if provided (active, canceled, incomplete, etc.)
        if (status) {
            params.status = status;
        }

        // Filter by creation time - Unix timestamp
        if (created_since) {
            params.created = {
                gte: parseInt(created_since)
            };
            console.log(`[INFO] Filtering subscriptions created since: ${new Date(parseInt(created_since) * 1000).toISOString()}`);
        }
        // Helper: filter by hours ago (e.g., created_hours_ago=24 for last 24 hours)
        else if (created_hours_ago) {
            const hoursAgo = parseInt(created_hours_ago);
            const timestamp = Math.floor(Date.now() / 1000) - (hoursAgo * 3600);
            params.created = {
                gte: timestamp
            };
            console.log(`[INFO] Filtering subscriptions created in last ${hoursAgo} hours (since: ${new Date(timestamp * 1000).toISOString()})`);
        }

        // Pagination support
        if (starting_after) {
            params.starting_after = starting_after;
        }

        const subscriptions = await stripe.subscriptions.list(params);

        return res.json({
            success: true,
            subscriptions: subscriptions.data,
            count: subscriptions.data.length,
            has_more: subscriptions.has_more,
            // Provide next page cursor if there are more results
            next_cursor: subscriptions.has_more ? subscriptions.data[subscriptions.data.length - 1].id : null
        });

    } catch (error) {
        console.error('[ERROR] Failed to fetch subscriptions:', error);

        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch subscriptions',
            status: 'server_error'
        });
    }
});

// Server setup and routes

// Global error handler
server.use((error, req, res, next) => {
    console.error('Global error handler:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// ─── Drauwper routes (drops, contributions, reviews, etc.) ───
// drauwperRoutes(server, pool, authenticateToken, PROXY, { storage, BUCKET_NAME, DEST_PREFIX });

// Serve banner uploads locally (dev fallback when GCS not configured)
// server.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Admin panel (mounted before 404 catch-all) ───
const adminRouter = createAdminRouter({
    pool,
    analytics,
    logs,
    dbConfig,
    getLogFilePath: () => LOG_FILE,
});

server.use('/admin', adminRouter);

// 404 — API and admin only; frontend is served separately on Vercel
server.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
    try {
        // Test database connection
        await knex.raw('SELECT 1');
        console.log('🚀 Express Server with MySQL is running on port', PORT);
        console.log('�️  Database: FaceBlurr (MySQL)');
        console.log('🌐 API Base URL: http://localhost:' + PORT + PROXY + '/api');
        // console.log('🐍 Python Service: python-service.cjs (direct child_process)');
        console.log('📋 Available endpoints:');
        console.log('   - GET /api/userData');
        // console.log('   - GET /api/createdKeys');
        // console.log('   - GET /api/unlocks/:username');
        console.log('   - GET /api/purchases/:username');
        console.log('   - GET /api/redemptions/:username');
        console.log('   - GET /api/notifications/:username');
        console.log('   - POST /api/auth/login');
        console.log('   - GET /api/wallet/balance');
        console.log('   - POST /api/unlock/:keyId');
        console.log('   - GET /api/listings');
        console.log('   - POST /api/create-key');
        console.log('   - GET /api/:table');
        console.log('   - GET /api/:table/:id');
        console.log('   - PATCH /api/:table/:id');

        syncStripeTransactionsCron(100).catch((err) => {
            console.error('Initial Stripe transaction sync error:', err.message || err);
        });
    } catch (error) {
        console.error('❌ Failed to connect to MySQL database:', error.message);
        console.log('📝 Please ensure:');
        console.log('   1. MySQL server is running');
        console.log('   2. FaceBlurr database exists');
        console.log('   3. Database credentials are correct in server.cjs');
        process.exit(1);
    }
});
// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    await knex.destroy();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    await knex.destroy();
    process.exit(0);
});
