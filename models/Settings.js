const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  dailyLimit: {
    type: Number,
    default: 50
  },
  companySignature: {
    type: String,
    default: `<p>Regards,<br><strong>Futurise Solutions</strong><br>Website: <a href="https://www.futurisesolutions.com" target="_blank">https://www.futurisesolutions.com</a></p>`
  },
  cataloguePdfPath: {
    type: String,
    default: ''
  },
  geminiApiKey: {
    type: String,
    default: ''
  },
  groqApiKey: {
    type: String,
    default: ''
  },
  emailService: {
    type: String,
    enum: ['smtp', 'resend'],
    default: 'smtp'
  },
  smtpConfig: {
    host: { type: String, default: '' },
    port: { type: Number, default: 587 },
    secure: { type: Boolean, default: false },
    user: { type: String, default: '' },
    pass: { type: String, default: '' },
    fromEmail: { type: String, default: '' }
  },
  resendConfig: {
    apiKey: { type: String, default: '' },
    fromEmail: { type: String, default: '' }
  },
  schedules: {
    initial: {
      enabled: { type: Boolean, default: false },
      hour: { type: Number, default: 3, min: 0, max: 23 },
      minute: { type: Number, default: 0, min: 0, max: 59 },
      batchSize: { type: Number, default: 20, min: 1 }
    },
    followup1: {
      enabled: { type: Boolean, default: false },
      hour: { type: Number, default: 3, min: 0, max: 23 },
      minute: { type: Number, default: 0, min: 0, max: 59 },
      batchSize: { type: Number, default: 20, min: 1 }
    },
    followup2: {
      enabled: { type: Boolean, default: false },
      hour: { type: Number, default: 3, min: 0, max: 23 },
      minute: { type: Number, default: 0, min: 0, max: 59 },
      batchSize: { type: Number, default: 20, min: 1 }
    }
  }
}, {
  timestamps: true
});

// Static helper to get the singleton settings document
settingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }

  // Fallback to environment variables if database keys are blank
  if (!settings.geminiApiKey && process.env.GEMINI_API_KEY) {
    settings.geminiApiKey = process.env.GEMINI_API_KEY;
  }
  if (!settings.groqApiKey && process.env.GROQ_API_KEY) {
    settings.groqApiKey = process.env.GROQ_API_KEY;
  }

  if (settings.smtpConfig) {
    if (!settings.smtpConfig.host && process.env.SMTP_HOST) {
      settings.smtpConfig.host = process.env.SMTP_HOST;
    }
    if ((!settings.smtpConfig.user || settings.smtpConfig.user === '') && process.env.SMTP_USER) {
      settings.smtpConfig.user = process.env.SMTP_USER;
    }
    if ((!settings.smtpConfig.pass || settings.smtpConfig.pass === '') && process.env.SMTP_PASS) {
      settings.smtpConfig.pass = process.env.SMTP_PASS;
    }
    if ((!settings.smtpConfig.fromEmail || settings.smtpConfig.fromEmail === '') && process.env.SMTP_FROM) {
      settings.smtpConfig.fromEmail = process.env.SMTP_FROM;
    }
    if (process.env.SMTP_PORT && settings.smtpConfig.port === 587 && process.env.SMTP_PORT !== '587') {
      settings.smtpConfig.port = Number(process.env.SMTP_PORT);
    }
    if (process.env.SMTP_SECURE !== undefined && !settings.smtpConfig.secure && process.env.SMTP_SECURE === 'true') {
      settings.smtpConfig.secure = true;
    }
  }

  if (settings.resendConfig) {
    if (!settings.resendConfig.apiKey && process.env.RESEND_API_KEY) {
      settings.resendConfig.apiKey = process.env.RESEND_API_KEY;
    }
    if ((!settings.resendConfig.fromEmail || settings.resendConfig.fromEmail === '' || settings.resendConfig.fromEmail === 'business@futurisesolutions.com') && process.env.RESEND_FROM) {
      settings.resendConfig.fromEmail = process.env.RESEND_FROM;
    }
  }

  return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);
