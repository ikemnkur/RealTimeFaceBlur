const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config();

const TEMPLATE_DIR = path.join(__dirname, "email-templates");

// Amazon SES SMTP Configuration - not used anymore since we switched to Sendlush, but keeping this here in case we need to switch back or use SES directly for some reason
// Sendlush is used in production, but these env vars can be set to use SES directly if needed
const SES_SMTP_HOST = process.env.SES_SMTP_HOST || "email-smtp.us-east-1.amazonaws.com";
const SES_SMTP_PORT = parseInt(process.env.SES_SMTP_PORT || "587", 10);
const SES_SMTP_USER = process.env.SES_SMTP_USER || "";
const SES_SMTP_PASSWORD = process.env.SES_SMTP_PASSWORD || "";

const DEFAULT_FROM_EMAIL = process.env.EMAIL_FROM || "no-reply@FaceBlurr.com";
const DEFAULT_FROM_NAME = process.env.EMAIL_FROM_NAME || "FaceBlurr";

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).replace(/\n/g, "<br/>");
}

function renderTemplate(html, variables = {}) {
    let rendered = html;
    Object.entries(variables).forEach(([key, value]) => {
        const safeValue = normalizeValue(value);
        const token = new RegExp(`{{${escapeRegExp(key)}}}`, "g");
        rendered = rendered.replace(token, safeValue);
    });

    return rendered.replace(/{{[A-Z0-9_]+}}/g, "");
}

function loadTemplate(templateFile) {
    const filePath = path.join(TEMPLATE_DIR, templateFile);
    return fs.readFileSync(filePath, "utf8");
}

function createTransporter() {
    if (!SES_SMTP_USER || !SES_SMTP_PASSWORD) {
        throw new Error("Amazon SES credentials are not configured. Please set SES_SMTP_USER and SES_SMTP_PASSWORD environment variables.");
    }

    return nodemailer.createTransport({
        host: SES_SMTP_HOST,
        port: SES_SMTP_PORT,
        secure: false, // true for 465, false for other ports (587 uses STARTTLS)
        auth: {
            user: SES_SMTP_USER,
            pass: SES_SMTP_PASSWORD
        },
        // Optional: Add connection timeout and other settings
        connectionTimeout: 10000, // 10 seconds
        greetingTimeout: 5000,
        socketTimeout: 20000
    });
}

async function sendTemplatedEmail({
    to,
    subject,
    templateFile,
    variables = {},
    fromEmail = DEFAULT_FROM_EMAIL,
    fromName = DEFAULT_FROM_NAME,
    replyTo
}) {
    if (!to) {
        throw new Error("Recipient email address is required.");
    }

    const html = renderTemplate(loadTemplate(templateFile), variables);
    const transporter = createTransporter();

    return transporter.sendMail({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        html,
        replyTo
    });
}

async function sendRawEmail({
    to,
    subject,
    html,
    text,
    fromEmail = DEFAULT_FROM_EMAIL,
    fromName = DEFAULT_FROM_NAME,
    replyTo
}) {
    if (!to) {
        throw new Error("Recipient email address is required.");
    }

    if (!html && !text) {
        throw new Error("Email content is required.");
    }

    const transporter = createTransporter();

    return transporter.sendMail({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        html,
        text,
        replyTo
    });
}

function buildCommonVariables(overrides = {}) {
    return {
        YEAR: new Date().getFullYear(),
        ...overrides
    };
}

async function sendAccountVerificationEmail({
    to,
    username,
    verificationLink,
    verificationCode,
    subject = "Verify your FaceBlurr account"
}) {
    return sendTemplatedEmail({
        to,
        subject,
        templateFile: "account-verification.html",
        variables: buildCommonVariables({
            USERNAME: username,
            VERIFICATION_LINK: verificationLink,
            VERIFICATION_CODE: verificationCode
        })
    });
}

async function sendPasswordResetEmail({
    to,
    username,
    resetCode,
    subject = "Reset your FaceBlurr password"
}) {
    return sendTemplatedEmail({
        to,
        subject,
        templateFile: "password-reset.html",
        variables: buildCommonVariables({
            USERNAME: username,
            RESET_CODE: resetCode
        })
    });
}

async function sendPromoSalesEmail({
    to,
    username,
    discountPercent,
    basicPrice,
    premiumPrice,
    proPrice,
    upgradeLink,
    expiryDate,
    promoCode,
    subject = "Limited-time upgrade offer"
}) {
    return sendTemplatedEmail({
        to,
        subject,
        templateFile: "promo-sales.html",
        variables: buildCommonVariables({
            USERNAME: username,
            DISCOUNT_PERCENT: discountPercent,
            BASIC_PRICE: basicPrice,
            PREMIUM_PRICE: premiumPrice,
            PRO_PRICE: proPrice,
            UPGRADE_LINK: upgradeLink,
            EXPIRY_DATE: expiryDate,
            PROMO_CODE: promoCode
        })
    });
}

async function sendMonthlyNewsletterEmail({
    to,
    username,
    month,
    year,
    featuredTitle,
    featuredDescription,
    feature1Title,
    feature1Desc,
    feature2Title,
    feature2Desc,
    feature3Title,
    feature3Desc,
    faceblurrsCount,
    creditsUsed,
    keysSold,
    tipOfTheMonth,
    comingSoonText,
    dashboardLink,
    twitterLink,
    youtubeLink,
    instagramLink,
    subject
}) {
    const effectiveYear = year || new Date().getFullYear();
    const effectiveSubject = subject || `FaceBlurr Monthly — ${month} ${effectiveYear}`;

    return sendTemplatedEmail({
        to,
        subject: effectiveSubject,
        templateFile: "monthly-newsletter.html",
        variables: buildCommonVariables({
            USERNAME: username,
            MONTH: month,
            YEAR: effectiveYear,
            FEATURED_TITLE: featuredTitle,
            FEATURED_DESCRIPTION: featuredDescription,
            FEATURE_1_TITLE: feature1Title,
            FEATURE_1_DESC: feature1Desc,
            FEATURE_2_TITLE: feature2Title,
            FEATURE_2_DESC: feature2Desc,
            FEATURE_3_TITLE: feature3Title,
            FEATURE_3_DESC: feature3Desc,
            FACEBLURRS_COUNT: faceblurrsCount,
            CREDITS_USED: creditsUsed,
            KEYS_SOLD: keysSold,
            TIP_OF_THE_MONTH: tipOfTheMonth,
            COMING_SOON_TEXT: comingSoonText,
            DASHBOARD_LINK: dashboardLink,
            TWITTER_LINK: twitterLink,
            YOUTUBE_LINK: youtubeLink,
            INSTAGRAM_LINK: instagramLink
        })
    });
}

async function sendAccountNoticeEmail({
    to,
    username,
    noticeType,
    noticeTitle,
    noticeMessage,
    noticeBadgeBg,
    noticeBadgeText,
    detailsTitle,
    detail1Label,
    detail1Value,
    detail2Label,
    detail2Value,
    detail3Label,
    detail3Value,
    detailTotalLabel,
    detailTotalValue,
    actionBorderColor,
    actionTitle,
    actionMessage,
    actionLink,
    actionButtonText,
    referenceId,
    noticeDate,
    helpCenterLink,
    subject = "Account Notice"
}) {
    return sendTemplatedEmail({
        to,
        subject,
        templateFile: "account-notice.html",
        variables: buildCommonVariables({
            USERNAME: username,
            NOTICE_TYPE: noticeType,
            NOTICE_TITLE: noticeTitle,
            NOTICE_MESSAGE: noticeMessage,
            NOTICE_BADGE_BG: noticeBadgeBg,
            NOTICE_BADGE_TEXT: noticeBadgeText,
            DETAILS_TITLE: detailsTitle,
            DETAIL_1_LABEL: detail1Label,
            DETAIL_1_VALUE: detail1Value,
            DETAIL_2_LABEL: detail2Label,
            DETAIL_2_VALUE: detail2Value,
            DETAIL_3_LABEL: detail3Label,
            DETAIL_3_VALUE: detail3Value,
            DETAIL_TOTAL_LABEL: detailTotalLabel,
            DETAIL_TOTAL_VALUE: detailTotalValue,
            ACTION_BORDER_COLOR: actionBorderColor,
            ACTION_TITLE: actionTitle,
            ACTION_MESSAGE: actionMessage,
            ACTION_LINK: actionLink,
            ACTION_BUTTON_TEXT: actionButtonText,
            REFERENCE_ID: referenceId,
            NOTICE_DATE: noticeDate,
            HELP_CENTER_LINK: helpCenterLink
        })
    });
}

async function sendCustomerSupportEmail({
    to,
    username,
    ticketId,
    ticketStatus,
    statusBg,
    statusText,
    responseType,
    responseDate,
    supportMessage,
    originalMessage,
    originalDate,
    step1,
    step2,
    step3,
    replyLink,
    subject = "Your support ticket update"
}) {
    return sendTemplatedEmail({
        to,
        subject,
        templateFile: "customer-support.html",
        variables: buildCommonVariables({
            USERNAME: username,
            TICKET_ID: ticketId,
            TICKET_STATUS: ticketStatus,
            STATUS_BG: statusBg,
            STATUS_TEXT: statusText,
            RESPONSE_TYPE: responseType,
            RESPONSE_DATE: responseDate,
            SUPPORT_MESSAGE: supportMessage,
            ORIGINAL_MESSAGE: originalMessage,
            ORIGINAL_DATE: originalDate,
            STEP_1: step1,
            STEP_2: step2,
            STEP_3: step3,
            REPLY_LINK: replyLink
        })
    });
}

module.exports = {
    renderTemplate,
    sendRawEmail,
    sendTemplatedEmail,
    sendAccountVerificationEmail,
    sendPasswordResetEmail,
    sendPromoSalesEmail,
    sendMonthlyNewsletterEmail,
    sendAccountNoticeEmail,
    sendCustomerSupportEmail
};
