const mongoose = require('mongoose');

const emailHistorySchema = new mongoose.Schema({
  leadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    required: true
  },
  type: {
    type: String,
    enum: ['initial', 'followup_1', 'followup_2'],
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  html: {
    type: String
  },
  text: {
    type: String
  },
  aiProvider: {
    type: String,
    enum: ['gemini', 'groq', null],
    default: null
  },
  sendStatus: {
    type: String,
    enum: ['success', 'failed'],
    required: true
  },
  smtpResponse: {
    type: String,
    default: ''
  },
  error: {
    type: String,
    default: ''
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

emailHistorySchema.index({ leadId: 1 });
emailHistorySchema.index({ sentAt: 1 });

module.exports = mongoose.model('EmailHistory', emailHistorySchema);
