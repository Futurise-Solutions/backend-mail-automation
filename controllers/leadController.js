const fs = require('fs');
const csv = require('csv-parser');
const Lead = require('../models/Lead');
const EmailHistory = require('../models/EmailHistory');
const Settings = require('../models/Settings');
const aiService = require('../services/aiService');
const emailService = require('../services/emailService');
const queueService = require('../services/queueService');
const logger = require('../config/logger');

// Helper function to parse CSV files
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => {
        // Normalise headers: trim keys and lowercase them
        const normalisedRow = {};
        Object.keys(data).forEach((key) => {
          const cleanKey = key.trim().toLowerCase();
          normalisedRow[cleanKey] = data[key] ? data[key].trim() : '';
        });
        results.push(normalisedRow);
      })
      .on('error', (err) => reject(err))
      .on('end', () => resolve(results));
  });
};

/**
 * POST /leads/upload
 * Parse CSV and import leads. Checks for duplicates in CSV & Database.
 */
exports.uploadLeads = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a CSV file' });
    }

    const results = await parseCSV(req.file.path);
    
    if (results.length === 0) {
      return res.status(400).json({ success: false, message: 'CSV file is empty' });
    }

    // Validate headers
    const requiredHeaders = ['name', 'email', 'company', 'role'];
    const firstRow = results[0];
    const headers = Object.keys(firstRow);
    const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));

    if (missingHeaders.length > 0) {
      // Cleanup file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        success: false, 
        message: `Missing required columns in CSV: ${missingHeaders.join(', ')}` 
      });
    }

    let insertedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    const invalidRows = [];
    
    const processedEmails = new Set();
    const emailToIdMap = new Map();

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const rowNum = i + 2; // header is row 1

      // A. Empty checks
      if (!row.name || !row.email || !row.company || !row.role) {
        invalidCount++;
        invalidRows.push({ rowNum, email: row.email || 'N/A', reason: 'Missing required field (name, email, company, role)' });
        continue;
      }

      // B. Email regex check
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(row.email)) {
        invalidCount++;
        invalidRows.push({ rowNum, email: row.email, reason: 'Invalid email format' });
        continue;
      }

      const lowerEmail = row.email.toLowerCase();

      // C. Duplicate check inside the same CSV file
      if (processedEmails.has(lowerEmail)) {
        const firstOccurrenceId = emailToIdMap.get(lowerEmail);
        
        await Lead.create({
          name: row.name,
          email: lowerEmail,
          company: row.company,
          role: row.role,
          industry: row.industry,
          linkedin: row.linkedin,
          website: row.website,
          status: 'DUPLICATE',
          duplicate: true,
          duplicateOf: firstOccurrenceId || null
        });
        
        duplicateCount++;
        continue;
      }

      // D. Duplicate check against existing DB
      const existingInDB = await Lead.findOne({ email: lowerEmail, status: { $ne: 'DUPLICATE' } });
      if (existingInDB) {
        await Lead.create({
          name: row.name,
          email: lowerEmail,
          company: row.company,
          role: row.role,
          industry: row.industry,
          linkedin: row.linkedin,
          website: row.website,
          status: 'DUPLICATE',
          duplicate: true,
          duplicateOf: existingInDB._id
        });
        
        duplicateCount++;
        processedEmails.add(lowerEmail);
        continue;
      }

      // E. Clean insertion
      const newLead = await Lead.create({
        name: row.name,
        email: lowerEmail,
        company: row.company,
        role: row.role,
        industry: row.industry,
        linkedin: row.linkedin,
        website: row.website,
        status: 'FRESH'
      });

      insertedCount++;
      processedEmails.add(lowerEmail);
      emailToIdMap.set(lowerEmail, newLead._id);
    }

    // Remove file from uploads folder after processing
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      logger.error(`Error deleting uploaded csv: ${err.message}`);
    }

    return res.status(200).json({
      success: true,
      summary: {
        totalRows: results.length,
        inserted: insertedCount,
        duplicates: duplicateCount,
        invalid: invalidCount,
        invalidRows
      }
    });

  } catch (error) {
    logger.error(`Lead upload error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error parsing CSV file' });
  }
};

/**
 * GET /leads
 * Get lead listing with filtering, sorting, pagination, and search.
 */
exports.getLeads = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      search = '', 
      role, 
      industry, 
      status, 
      reply, 
      followupCount, 
      duplicate, 
      fresh, 
      skipped,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = {};

    // A. Text Search
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { role: { $regex: search, $options: 'i' } }
      ];
    }

    // B. Direct filters
    if (role) query.role = role;
    if (industry) query.industry = industry;
    if (status) query.status = status;
    if (reply !== undefined) query.replyReceived = reply === 'true';
    if (followupCount !== undefined) query.followupCount = Number(followupCount);

    // C. Specialized filters
    if (duplicate === 'true') {
      query.status = 'DUPLICATE';
    } else if (duplicate === 'false') {
      query.status = { $ne: 'DUPLICATE' };
    }
    if (fresh === 'true') query.status = 'FRESH';
    if (skipped === 'true') query.status = 'SKIPPED';

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const leads = await Lead.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .populate('duplicateOf', 'name email company');

    const totalLeads = await Lead.countDocuments(query);

    // Fetch unique fields list for filters
    const rolesList = await Lead.distinct('role');
    const industriesList = await Lead.distinct('industry');

    return res.status(200).json({
      success: true,
      leads,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalLeads / limitNum),
        totalLeads
      },
      filters: {
        roles: rolesList.filter(Boolean),
        industries: industriesList.filter(Boolean)
      }
    });

  } catch (error) {
    logger.error(`Get leads error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error retrieving leads' });
  }
};

/**
 * GET /lead/:id
 * Get details of a single lead, including sent history
 */
exports.getLeadById = async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id).populate('duplicateOf', 'name email company');
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const history = await EmailHistory.find({ leadId: lead._id }).sort({ sentAt: -1 });

    return res.status(200).json({ success: true, lead, history });
  } catch (error) {
    logger.error(`Get lead by ID error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error retrieving lead details' });
  }
};

/**
 * PUT /lead/:id
 * Update details of a lead
 */
exports.updateLead = async (req, res) => {
  try {
    const { name, email, company, role, industry, linkedin, website, status } = req.body;
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if (name) lead.name = name;
    if (email) lead.email = email.toLowerCase().trim();
    if (company) lead.company = company;
    if (role) lead.role = role;
    if (industry) lead.industry = industry;
    if (linkedin) lead.linkedin = linkedin;
    if (website) lead.website = website;
    if (status) lead.status = status; // Allows manual status modifications or skipping

    await lead.save();
    return res.status(200).json({ success: true, message: 'Lead updated successfully', lead });
  } catch (error) {
    logger.error(`Update lead error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error updating lead' });
  }
};

/**
 * DELETE /lead/:id
 * Delete a lead and its email logs
 */
exports.deleteLead = async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    // Delete associated email histories
    await EmailHistory.deleteMany({ leadId: req.params.id });

    return res.status(200).json({ success: true, message: 'Lead and history deleted successfully' });
  } catch (error) {
    logger.error(`Delete lead error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error deleting lead' });
  }
};

/**
 * POST /lead/send
 * SSE endpoint for triggering a batch run of initial emails
 */
exports.triggerBatchSend = async (req, res) => {
  const count = Number(req.body.count) || 10;

  // Establish Server-Sent Events headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Establish the connection immediately

  // Start processing in the queue service, piping events directly to res
  await queueService.processInitialBatch(count, res);
  res.end(); // close SSE stream
};

/**
 * POST /lead/followup
 * SSE endpoint for triggering a batch run of followups
 */
exports.triggerFollowupBatch = async (req, res) => {
  const count = Number(req.body.count) || 10;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  await queueService.processFollowUpBatch(count, res);
  res.end();
};

/**
 * POST /lead/send-single
 * Immediately generates and sends an email to a single lead.
 * Bypasses the batch queue, daily limits, and concurrency delay (useful for testing).
 */
exports.sendSingleEmail = async (req, res) => {
  const { id } = req.body;

  try {
    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if (['DUPLICATE', 'INACTIVE', 'REPLIED'].includes(lead.status)) {
      return res.status(400).json({ success: false, message: `Lead is in a ${lead.status} state. Cannot send email.` });
    }

    const settings = await Settings.getSettings();
    let emailContent = lead.generatedEmail;
    let provider = lead.aiProvider;

    // A. Generate if needed
    if (!emailContent || !emailContent.subject || !emailContent.html) {
      try {
        const generated = await aiService.generateColdEmail(lead);
        emailContent = {
          subject: generated.subject,
          html: generated.html,
          text: generated.text
        };
        provider = generated.provider;

        lead.generatedEmail = emailContent;
        lead.aiProvider = provider;
        lead.status = 'AI_GENERATED';
        await lead.save();
      } catch (aiErr) {
        lead.status = 'SKIPPED';
        lead.errorLog.push({
          stage: 'ai_generation',
          provider: 'gemini/groq',
          reason: aiErr.message
        });
        await lead.save();
        return res.status(500).json({ success: false, message: `AI content generation failed: ${aiErr.message}` });
      }
    }

    // B. Send immediately
    try {
      const sendResult = await emailService.sendEmail({
        to: lead.email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text
      });

      lead.status = 'EMAIL_SENT';
      lead.emailStatus = 'sent';
      lead.followupCount = 0;
      lead.lastSentEmail = emailContent;
      lead.lastSentAt = new Date();
      await lead.save();

      // Log email history
      await EmailHistory.create({
        leadId: lead._id,
        type: 'initial',
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        aiProvider: provider,
        sendStatus: 'success',
        smtpResponse: sendResult.response || 'Single send success'
      });

      return res.status(200).json({ success: true, message: 'Email sent successfully!', lead });

    } catch (sendErr) {
      lead.status = 'SKIPPED';
      lead.emailStatus = 'failed';
      lead.errorLog.push({
        stage: 'email_sending',
        provider: settings.emailService,
        reason: sendErr.message
      });
      await lead.save();

      await EmailHistory.create({
        leadId: lead._id,
        type: 'initial',
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        aiProvider: provider,
        sendStatus: 'failed',
        error: sendErr.message
      });

      return res.status(500).json({ success: false, message: `Email delivery failed: ${sendErr.message}` });
    }

  } catch (error) {
    logger.error(`Send single email error: ${error.message}`);
    return res.status(500).json({ success: false, message: `Server error: ${error.message}` });
  }
};

/**
 * POST /lead/reply
 * Mark reply status manually and record customer reply body
 */
exports.recordReply = async (req, res) => {
  const { id, replyText } = req.body;

  try {
    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    lead.replyReceived = true;
    lead.replyText = replyText || '';
    lead.status = 'REPLIED';
    await lead.save();

    logger.info(`Lead ${lead.email} marked as REPLIED`);
    return res.status(200).json({ success: true, message: 'Reply recorded successfully', lead });
  } catch (error) {
    logger.error(`Record reply error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error recording reply' });
  }
};

/**
 * POST /lead/suggest-reply
 * AI generates a recommended response message based on thread history
 */
exports.suggestReply = async (req, res) => {
  const { id } = req.body;

  try {
    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if (!lead.replyReceived) {
      return res.status(400).json({ success: false, message: 'Lead has not replied yet' });
    }

    const history = await EmailHistory.find({ leadId: lead._id, sendStatus: 'success' }).sort({ sentAt: 1 });
    const suggestion = await aiService.suggestReplyResponse(lead, history);

    return res.status(200).json({ success: true, suggestion });
  } catch (error) {
    logger.error(`Suggest reply error: ${error.message}`);
    return res.status(500).json({ success: false, message: `Failed to generate reply suggestion: ${error.message}` });
  }
};

/**
 * GET /dashboard
 * Renders statistical count tallies across all states
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const total = await Lead.countDocuments();
    const fresh = await Lead.countDocuments({ status: 'FRESH' });
    const skipped = await Lead.countDocuments({ status: 'SKIPPED' });
    const emailSent = await Lead.countDocuments({ status: 'EMAIL_SENT' });
    
    // Follow Up Pending: Initial email sent, no replies, followUp count < 2
    const followUpPending = await Lead.countDocuments({
      status: 'EMAIL_SENT',
      replyReceived: false,
      followupCount: { $lt: 2 }
    });

    const followup1Sent = await Lead.countDocuments({ status: 'FOLLOWUP_1_SENT' });
    const followup2Sent = await Lead.countDocuments({ status: 'FOLLOWUP_2_SENT' });
    const replied = await Lead.countDocuments({ status: 'REPLIED' });
    const inactive = await Lead.countDocuments({ status: 'INACTIVE' });
    const duplicate = await Lead.countDocuments({ status: 'DUPLICATE' });
    
    const failedAI = await Lead.countDocuments({ status: 'AI_FAILED' });
    const failedEmail = await Lead.countDocuments({ status: 'EMAIL_FAILED' });

    // Calculate progress counts today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sentToday = await EmailHistory.countDocuments({
      sentAt: { $gte: today },
      sendStatus: 'success'
    });

    const settings = await Settings.getSettings();

    return res.status(200).json({
      success: true,
      stats: {
        total,
        fresh,
        skipped,
        emailSent,
        followUpPending,
        followup1Sent,
        followup2Sent,
        replied,
        inactive,
        duplicate,
        failedAI,
        failedEmail,
        sentToday,
        dailyLimit: settings.dailyLimit
      }
    });

  } catch (error) {
    logger.error(`Get dashboard stats error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error fetching statistics' });
  }
};
