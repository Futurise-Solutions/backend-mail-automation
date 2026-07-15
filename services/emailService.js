const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const Settings = require('../models/Settings');
const logger = require('../config/logger');

/**
 * Send an email using the configured email service (SMTP or Resend).
 * 
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content
 * @param {boolean} options.attachCatalogue - Whether to attach the company catalogue PDF
 */
exports.sendEmail = async ({ to, subject, html, text, attachCatalogue = false }) => {
  const settings = await Settings.getSettings();
  const attachments = [];

  // If catalogue attachment is requested, verify if it exists and attach it.
  // CATALOGUE_PDF_PATH env var overrides MongoDB path — used in CI/GitHub Actions
  // where uploads/ is gitignored and the PDF lives in assets/ instead.
  if (attachCatalogue) {
    const pdfPath = process.env.CATALOGUE_PDF_PATH || settings.cataloguePdfPath;
    if (pdfPath) {
      const fullPath = path.resolve(pdfPath);
      if (fs.existsSync(fullPath)) {
        attachments.push({
          filename: 'Futurise_Solutions_Catalogue.pdf',
          path: fullPath
        });
      } else {
        logger.warn(`Catalogue PDF requested but file not found at: ${fullPath}`);
      }
    }
  }

  if (settings.emailService === 'smtp') {
    const { host, port, secure, user, pass, fromEmail } = settings.smtpConfig;

    if (!host || !user || !pass || !fromEmail) {
      throw new Error('SMTP configuration is incomplete. Please check Settings.');
    }

    logger.info(`Sending email to ${to} via SMTP (${host})...`);

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: secure === true || secure === 'true',
      auth: {
        user,
        pass
      }
    });

    const mailOptions = {
      from: `"Futurise Solutions" <${fromEmail}>`,
      to,
      subject,
      html,
      text,
      attachments
    };

    const info = await transporter.sendMail(mailOptions);
    logger.info(`Email successfully sent via SMTP: ${info.messageId}`);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
      provider: 'smtp'
    };

  } else if (settings.emailService === 'resend') {
    const { apiKey, fromEmail } = settings.resendConfig;

    if (!apiKey || !fromEmail) {
      throw new Error('Resend configuration is incomplete. Please check Settings.');
    }

    logger.info(`Sending email to ${to} via Resend API...`);

    // Prepare attachments for Resend API (Base64)
    const resendAttachments = [];
    for (const att of attachments) {
      try {
        const fileBuffer = fs.readFileSync(att.path);
        resendAttachments.push({
          filename: att.filename,
          content: fileBuffer.toString('base64')
        });
      } catch (err) {
        logger.error(`Failed to read attachment for Resend: ${err.message}`);
      }
    }

    const payload = {
      from: `"Futurise Solutions" <${fromEmail}>`,
      to,
      subject,
      html,
      text
    };

    if (resendAttachments.length > 0) {
      payload.attachments = resendAttachments;
    }

    // Call Resend REST API
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || `Resend API Error (Status: ${response.status})`);
    }

    logger.info(`Email successfully sent via Resend API: ${result.id}`);
    return {
      success: true,
      messageId: result.id,
      response: 'Resend API call success',
      provider: 'resend'
    };

  } else {
    throw new Error(`Unsupported email service configured: ${settings.emailService}`);
  }
};
