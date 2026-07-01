const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  company: {
    type: String,
    required: true,
    trim: true
  },
  role: {
    type: String,
    required: true,
    trim: true
  },
  industry: {
    type: String,
    trim: true
  },
  linkedin: {
    type: String,
    trim: true
  },
  website: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: [
      'FRESH',
      'SKIPPED',
      'EMAIL_SENT',
      'FOLLOWUP_1_SENT',
      'FOLLOWUP_2_SENT',
      'REPLIED',
      'INACTIVE',
      'DUPLICATE',
      'AI_FAILED',
      'EMAIL_FAILED',
      'AI_GENERATED'
    ],
    default: 'FRESH',
    required: true
  },
  emailStatus: {
    type: String,
    enum: ['none', 'generating', 'generated', 'sending', 'sent', 'failed'],
    default: 'none'
  },
  followupCount: {
    type: Number,
    default: 0
  },
  replyReceived: {
    type: Boolean,
    default: false
  },
  replyText: {
    type: String,
    default: ''
  },
  duplicate: {
    type: Boolean,
    default: false
  },
  duplicateOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    default: null
  },
  generatedEmail: {
    subject: { type: String, default: '' },
    html: { type: String, default: '' },
    text: { type: String, default: '' }
  },
  lastSentEmail: {
    subject: { type: String, default: '' },
    html: { type: String, default: '' },
    text: { type: String, default: '' }
  },
  lastSentAt: {
    type: Date,
    default: null
  },
  lastFollowupAt: {
    type: Date,
    default: null
  },
  inactiveAt: {
    type: Date,
    default: null
  },
  aiProvider: {
    type: String,
    enum: ['gemini', 'groq', null],
    default: null
  },
  errorLog: [{
    timestamp: { type: Date, default: Date.now },
    stage: { type: String, required: true }, // e.g. 'ai_generation', 'email_sending'
    provider: { type: String }, // e.g. 'gemini', 'groq', 'smtp', 'resend'
    reason: { type: String, required: true }
  }],
  retryCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index by email and status for faster lookups and queuing
leadSchema.index({ email: 1 });
leadSchema.index({ status: 1 });

module.exports = mongoose.model('Lead', leadSchema);
