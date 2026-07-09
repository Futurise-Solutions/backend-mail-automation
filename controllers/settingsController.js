const fs = require('fs');
const path = require('path');
const Settings = require('../models/Settings');
const logger = require('../config/logger');

// Masking helpers
const maskKey = (key, type) => {
  if (!key) return '';
  if (type === 'gemini') return 'sk-gemini-••••••••';
  if (type === 'groq') return 'sk-groq-••••••••';
  if (type === 'resend') return 're-••••••••';
  return '••••••••';
};

const isMasked = (val) => {
  if (!val) return false;
  return val.includes('••••') || val === '••••••••';
};

/**
 * GET /settings
 * Get current system settings with masked secrets
 */
exports.getSettings = async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    
    // Mask sensitive credentials
    const responseSettings = settings.toObject();
    
    responseSettings.geminiApiKey = responseSettings.geminiApiKey ? maskKey(responseSettings.geminiApiKey, 'gemini') : '';
    responseSettings.groqApiKey = responseSettings.groqApiKey ? maskKey(responseSettings.groqApiKey, 'groq') : '';
    
    if (responseSettings.smtpConfig) {
      responseSettings.smtpConfig.pass = responseSettings.smtpConfig.pass ? maskKey(responseSettings.smtpConfig.pass, 'smtp') : '';
    }
    
    if (responseSettings.resendConfig) {
      responseSettings.resendConfig.apiKey = responseSettings.resendConfig.apiKey ? maskKey(responseSettings.resendConfig.apiKey, 'resend') : '';
    }

    return res.status(200).json({ success: true, settings: responseSettings });
  } catch (error) {
    logger.error(`Get settings error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error retrieving settings' });
  }
};

/**
 * PUT /settings
 * Update global configurations
 */
exports.updateSettings = async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    const updates = req.body;

    // Parse configs if sent as strings (from multipart-form CSV / file uploads)
    let smtpConfig = updates.smtpConfig;
    if (typeof smtpConfig === 'string') {
      try {
        smtpConfig = JSON.parse(smtpConfig);
      } catch (err) {
        logger.error(`Failed to parse smtpConfig string: ${err.message}`);
      }
    }
    let resendConfig = updates.resendConfig;
    if (typeof resendConfig === 'string') {
      try {
        resendConfig = JSON.parse(resendConfig);
      } catch (err) {
        logger.error(`Failed to parse resendConfig string: ${err.message}`);
      }
    }
    let schedules = updates.schedules;
    if (typeof schedules === 'string') {
      try {
        schedules = JSON.parse(schedules);
      } catch (err) {
        logger.error(`Failed to parse schedules string: ${err.message}`);
      }
    }

    // 1. General Configs
    if (updates.dailyLimit !== undefined) {
      settings.dailyLimit = Number(updates.dailyLimit);
    }
    if (updates.companySignature !== undefined) {
      settings.companySignature = updates.companySignature;
    }
    if (updates.emailService !== undefined) {
      settings.emailService = updates.emailService;
    }

    // 2. Secret Keys Update (only if not masked value)
    if (updates.geminiApiKey && !isMasked(updates.geminiApiKey)) {
      settings.geminiApiKey = updates.geminiApiKey;
    }
    if (updates.groqApiKey && !isMasked(updates.groqApiKey)) {
      settings.groqApiKey = updates.groqApiKey;
    }

    // 3. SMTP Config Update
    if (smtpConfig) {
      if (smtpConfig.host !== undefined) settings.smtpConfig.host = smtpConfig.host;
      if (smtpConfig.port !== undefined) settings.smtpConfig.port = Number(smtpConfig.port);
      if (smtpConfig.secure !== undefined) settings.smtpConfig.secure = smtpConfig.secure === true || smtpConfig.secure === 'true';
      if (smtpConfig.user !== undefined) settings.smtpConfig.user = smtpConfig.user;
      if (smtpConfig.fromEmail !== undefined) settings.smtpConfig.fromEmail = smtpConfig.fromEmail;
      
      // Update password only if provided and not the masked placeholder
      if (smtpConfig.pass && !isMasked(smtpConfig.pass)) {
        settings.smtpConfig.pass = smtpConfig.pass;
      }
    }

    // 4. Resend Config Update
    if (resendConfig) {
      if (resendConfig.fromEmail !== undefined) settings.resendConfig.fromEmail = resendConfig.fromEmail;
      
      // Update key only if not masked
      if (resendConfig.apiKey && !isMasked(resendConfig.apiKey)) {
        settings.resendConfig.apiKey = resendConfig.apiKey;
      }
    }

    // 5. Scheduled Send Config Update (per-level enable + time-of-day)
    if (schedules) {
      ['initial', 'followup1', 'followup2'].forEach((level) => {
        const incoming = schedules[level];
        if (!incoming) return;
        if (incoming.enabled !== undefined) {
          settings.schedules[level].enabled = incoming.enabled === true || incoming.enabled === 'true';
        }
        if (incoming.hour !== undefined) {
          settings.schedules[level].hour = Math.min(23, Math.max(0, Number(incoming.hour)));
        }
        if (incoming.minute !== undefined) {
          settings.schedules[level].minute = Math.min(59, Math.max(0, Number(incoming.minute)));
        }
        if (incoming.batchSize !== undefined) {
          settings.schedules[level].batchSize = Math.max(1, Number(incoming.batchSize));
        }
      });
    }

    // 6. File upload for PDF Catalogue
    if (req.file) {
      // Delete old catalogue if exists
      if (settings.cataloguePdfPath) {
        const oldPath = path.resolve(settings.cataloguePdfPath);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch (err) {
            logger.error(`Error deleting old catalogue file: ${err.message}`);
          }
        }
      }
      settings.cataloguePdfPath = req.file.path;
    }

    await settings.save();
    logger.info('Global settings updated successfully');

    // Return the settings (masked)
    return res.status(200).json({ 
      success: true, 
      message: 'Settings updated successfully',
      settings: await Settings.findOne() // will return saved settings, but let's let client query or mask it
    });
  } catch (error) {
    logger.error(`Update settings error: ${error.message}`);
    return res.status(500).json({ success: false, message: `Server error: ${error.message}` });
  }
};
