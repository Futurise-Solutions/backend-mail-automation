const Lead = require('../models/Lead');
const EmailHistory = require('../models/EmailHistory');
const Settings = require('../models/Settings');
const aiService = require('./aiService');
const emailService = require('./emailService');
const logger = require('../config/logger');

// Helper to generate a random delay between min and max seconds
const getRandomDelay = (min = 30, max = 90) => {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
};

// Helper for sleeping
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send SSE data helper
 */
const sendSSE = (res, data) => {
  if (res && typeof res.write === 'function') {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
};

/**
 * Process a batch of initial emails.
 */
exports.processInitialBatch = async (count, res) => {
  try {
    const settings = await Settings.getSettings();
    sendSSE(res, { type: 'info', message: 'Initializing batch campaign...' });

    // 1. Check daily sending limit
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sentToday = await EmailHistory.countDocuments({
      sentAt: { $gte: today },
      sendStatus: 'success'
    });

    const remainingLimit = settings.dailyLimit - sentToday;
    if (remainingLimit <= 0) {
      sendSSE(res, { 
        type: 'error', 
        message: `Daily limit of ${settings.dailyLimit} emails reached. ${sentToday} sent today. Batch halted.` 
      });
      return;
    }

    let batchSize = Math.min(count, remainingLimit);
    if (batchSize < count) {
      sendSSE(res, { 
        type: 'info', 
        message: `Batch capped at ${batchSize} (daily limit: ${settings.dailyLimit}, already sent: ${sentToday}).` 
      });
    }

    // 2. Select leads (Fresh first, then Skipped second, then AI_FAILED, then EMAIL_FAILED)
    let leads = await Lead.find({ status: 'FRESH' }).limit(batchSize);
    if (leads.length < batchSize) {
      const skippedLeads = await Lead.find({ status: 'SKIPPED' }).limit(batchSize - leads.length);
      leads = [...leads, ...skippedLeads];
    }
    if (leads.length < batchSize) {
      const failedAILeads = await Lead.find({ status: 'AI_FAILED' }).limit(batchSize - leads.length);
      leads = [...leads, ...failedAILeads];
    }
    if (leads.length < batchSize) {
      const failedEmailLeads = await Lead.find({ status: 'EMAIL_FAILED' }).limit(batchSize - leads.length);
      leads = [...leads, ...failedEmailLeads];
    }

    if (leads.length === 0) {
      sendSSE(res, { type: 'info', message: 'No eligible leads found. Batch completed.' });
      sendSSE(res, { type: 'complete', processed: 0, success: 0, failed: 0 });
      return;
    }

    sendSSE(res, { type: 'info', message: `Found ${leads.length} leads to process. Processing with concurrency 3.` });

    // Mark emailStatus as generating for locking
    await Lead.updateMany(
      { _id: { $in: leads.map(l => l._id) } },
      { $set: { emailStatus: 'generating' } }
    );

    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;

    // Queue processor with concurrency 3
    const queue = [...leads];
    const totalToProcess = queue.length;

    const runWorker = async () => {
      while (queue.length > 0) {
        const lead = queue.shift();
        if (!lead) break;

        const currentNum = ++processedCount;
        sendSSE(res, { 
          type: 'progress', 
          current: currentNum, 
          total: totalToProcess, 
          email: lead.email, 
          status: 'processing',
          message: `[${currentNum}/${totalToProcess}] Processing ${lead.name} (${lead.email})...`
        });

        let emailContent = lead.generatedEmail;
        let aiProviderUsed = lead.aiProvider;

        // A. Generate Email if not already generated
        if (!emailContent || !emailContent.subject || !emailContent.html) {
          try {
            sendSSE(res, { 
              type: 'progress', 
              current: currentNum, 
              total: totalToProcess, 
              email: lead.email, 
              status: 'ai_generating',
              message: `[${currentNum}/${totalToProcess}] Generating personalized AI content...`
            });

            const generated = await aiService.generateColdEmail(lead);
            emailContent = {
              subject: generated.subject,
              html: generated.html,
              text: generated.text
            };
            aiProviderUsed = generated.provider;

            // Save generated email
            lead.generatedEmail = emailContent;
            lead.aiProvider = aiProviderUsed;
            lead.status = 'AI_GENERATED';
            lead.emailStatus = 'generated';
            await lead.save();
          } catch (err) {
            logger.error(`AI Generation failed for ${lead.email}: ${err.message}`);
            
            // Save failure log
            lead.status = 'SKIPPED';
            lead.emailStatus = 'failed';
            lead.errorLog.push({
              stage: 'ai_generation',
              provider: 'gemini/groq',
              reason: err.message
            });
            await lead.save();

            failedCount++;
            sendSSE(res, { 
              type: 'progress', 
              current: currentNum, 
              total: totalToProcess, 
              email: lead.email, 
              status: 'ai_failed',
              message: `[${currentNum}/${totalToProcess}] AI generation failed for ${lead.name}: ${err.message}`
            });
            continue; // Go to next lead
          }
        }

        // B. Send Email
        let sendResult;
        let attempts = 0;
        const maxAttempts = 3; // 1 initial + 2 retries
        let sendError = '';

        sendSSE(res, { 
          type: 'progress', 
          current: currentNum, 
          total: totalToProcess, 
          email: lead.email, 
          status: 'sending',
          message: `[${currentNum}/${totalToProcess}] Sending email via SMTP/Resend...`
        });

        while (attempts < maxAttempts) {
          try {
            attempts++;
            lead.emailStatus = 'sending';
            await lead.save();

            sendResult = await emailService.sendEmail({
              to: lead.email,
              subject: emailContent.subject,
              html: emailContent.html,
              text: emailContent.text
            });
            break; // Succeeded, break retry loop
          } catch (err) {
            sendError = err.message || 'Unknown sending error';
            logger.error(`Email sending attempt ${attempts} failed for ${lead.email}: ${sendError}`);
            if (attempts < maxAttempts) {
              const retryDelay = 2000 * attempts; // exponential backoff
              await sleep(retryDelay);
            }
          }
        }

        if (sendResult && sendResult.success) {
          // Success
          lead.status = 'EMAIL_SENT';
          lead.emailStatus = 'sent';
          lead.followupCount = 0;
          lead.lastSentEmail = emailContent;
          lead.lastSentAt = new Date();
          await lead.save();

          // Create Email History
          await EmailHistory.create({
            leadId: lead._id,
            type: 'initial',
            subject: emailContent.subject,
            html: emailContent.html,
            text: emailContent.text,
            aiProvider: aiProviderUsed,
            sendStatus: 'success',
            smtpResponse: sendResult.response || 'Success'
          });

          successCount++;
          sendSSE(res, { 
            type: 'progress', 
            current: currentNum, 
            total: totalToProcess, 
            email: lead.email, 
            status: 'sent',
            message: `[${currentNum}/${totalToProcess}] Email sent successfully to ${lead.name} (${lead.email})!`
          });
        } else {
          // Permanently failed after retries
          lead.status = 'SKIPPED';
          lead.emailStatus = 'failed';
          lead.errorLog.push({
            stage: 'email_sending',
            provider: settings.emailService,
            reason: sendError || 'Failed after max retries'
          });
          await lead.save();

          // Create failed history record
          await EmailHistory.create({
            leadId: lead._id,
            type: 'initial',
            subject: emailContent.subject,
            html: emailContent.html,
            text: emailContent.text,
            aiProvider: aiProviderUsed,
            sendStatus: 'failed',
            error: sendError
          });

          failedCount++;
          sendSSE(res, { 
            type: 'progress', 
            current: currentNum, 
            total: totalToProcess, 
            email: lead.email, 
            status: 'failed',
            message: `[${currentNum}/${totalToProcess}] Failed to send email to ${lead.name}: ${sendError}`
          });
        }

        // C. Wait for anti-spam safety (except if last element, to avoid unnecessary delay at the end)
        if (queue.length > 0) {
          const delayTime = getRandomDelay(30, 90);
          sendSSE(res, { 
            type: 'delay', 
            message: `Waiting for ${delayTime / 1000} seconds before next email (anti-spam queue safety)...` 
          });
          await sleep(delayTime);
        }
      }
    };

    // Run 3 workers in parallel
    await Promise.all([runWorker(), runWorker(), runWorker()]);

    sendSSE(res, { 
      type: 'complete', 
      processed: totalToProcess, 
      success: successCount, 
      failed: failedCount 
    });

  } catch (err) {
    logger.error(`Initial Batch error: ${err.message}`);
    sendSSE(res, { type: 'error', message: `Server error during batch campaign: ${err.message}` });
  }
};

/**
 * Process follow-up batch campaign.
 */
exports.processFollowUpBatch = async (count, res) => {
  try {
    const settings = await Settings.getSettings();
    sendSSE(res, { type: 'info', message: 'Initializing follow-up campaign...' });

    // 1. Select eligible leads: 
    // Status is EMAIL_SENT (initial sent) OR FOLLOWUP_1_SENT
    // replyReceived must be false, followupCount < 2
    const leads = await Lead.find({
      status: { $in: ['EMAIL_SENT', 'FOLLOWUP_1_SENT'] },
      replyReceived: false,
      followupCount: { $lt: 2 }
    }).limit(count);

    if (leads.length === 0) {
      sendSSE(res, { type: 'info', message: 'No eligible leads for follow-up found.' });
      sendSSE(res, { type: 'complete', processed: 0, success: 0, failed: 0 });
      return;
    }

    sendSSE(res, { type: 'info', message: `Found ${leads.length} leads eligible for follow-up. Processing...` });

    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;

    const queue = [...leads];
    const totalToProcess = queue.length;

    const runWorker = async () => {
      while (queue.length > 0) {
        const lead = queue.shift();
        if (!lead) break;

        const currentNum = ++processedCount;
        const nextFollowUpNum = lead.followupCount + 1; // 1 or 2

        sendSSE(res, { 
          type: 'progress', 
          current: currentNum, 
          total: totalToProcess, 
          email: lead.email, 
          status: 'processing',
          message: `[${currentNum}/${totalToProcess}] Processing Follow-up #${nextFollowUpNum} for ${lead.name}...`
        });

        // Fetch last email history item for context
        const lastSentHistory = await EmailHistory.findOne({ 
          leadId: lead._id, 
          sendStatus: 'success' 
        }).sort({ sentAt: -1 });

        if (!lastSentHistory) {
          logger.error(`No previous email history found for lead ${lead.email} even though status was ${lead.status}`);
          continue;
        }

        // A. Generate Followup AI Content
        let followUpContent;
        let aiProviderUsed = 'gemini';

        try {
          sendSSE(res, { 
            type: 'progress', 
            current: currentNum, 
            total: totalToProcess, 
            email: lead.email, 
            status: 'ai_generating',
            message: `[${currentNum}/${totalToProcess}] Generating Follow-up #${nextFollowUpNum} content...`
          });

          const generated = await aiService.generateFollowUpEmail(lead, lastSentHistory, nextFollowUpNum);
          followUpContent = {
            subject: generated.subject,
            html: generated.html,
            text: generated.text
          };
          aiProviderUsed = generated.provider;
        } catch (err) {
          logger.error(`Follow-up AI Generation failed for ${lead.email}: ${err.message}`);
          lead.errorLog.push({
            stage: 'ai_followup_generation',
            provider: 'gemini/groq',
            reason: err.message
          });
          await lead.save();

          failedCount++;
          sendSSE(res, { 
            type: 'progress', 
            current: currentNum, 
            total: totalToProcess, 
            email: lead.email, 
            status: 'ai_failed',
            message: `[${currentNum}/${totalToProcess}] AI Follow-up content generation failed for ${lead.name}: ${err.message}`
          });
          continue;
        }

        // B. Send Follow-up Email
        let sendResult;
        let attempts = 0;
        const maxAttempts = 3;
        let sendError = '';

        sendSSE(res, { 
          type: 'progress', 
          current: currentNum, 
          total: totalToProcess, 
          email: lead.email, 
          status: 'sending',
          message: `[${currentNum}/${totalToProcess}] Sending Follow-up #${nextFollowUpNum} email...`
        });

        while (attempts < maxAttempts) {
          try {
            attempts++;
            sendResult = await emailService.sendEmail({
              to: lead.email,
              subject: followUpContent.subject,
              html: followUpContent.html,
              text: followUpContent.text,
              attachCatalogue: nextFollowUpNum === 1 // attach catalogue only for Follow Up 1
            });
            break;
          } catch (err) {
            sendError = err.message || 'Unknown sending error';
            if (attempts < maxAttempts) {
              await sleep(2000 * attempts);
            }
          }
        }

        if (sendResult && sendResult.success) {
          // Success
          lead.status = nextFollowUpNum === 1 ? 'FOLLOWUP_1_SENT' : 'FOLLOWUP_2_SENT';
          lead.followupCount = nextFollowUpNum;
          lead.lastFollowupAt = new Date();
          await lead.save();

          // Create Email History
          await EmailHistory.create({
            leadId: lead._id,
            type: nextFollowUpNum === 1 ? 'followup_1' : 'followup_2',
            subject: followUpContent.subject,
            html: followUpContent.html,
            text: followUpContent.text,
            aiProvider: aiProviderUsed,
            sendStatus: 'success',
            smtpResponse: sendResult.response || 'Success'
          });

          successCount++;
          sendSSE(res, { 
            type: 'progress', 
            current: currentNum, 
            total: totalToProcess, 
            email: lead.email, 
            status: 'sent',
            message: `[${currentNum}/${totalToProcess}] Follow-up #${nextFollowUpNum} sent successfully to ${lead.name}!`
          });
        } else {
          // Failed
          lead.errorLog.push({
            stage: 'followup_email_sending',
            provider: settings.emailService,
            reason: sendError || 'Failed after max retries'
          });
          await lead.save();

          await EmailHistory.create({
            leadId: lead._id,
            type: nextFollowUpNum === 1 ? 'followup_1' : 'followup_2',
            subject: followUpContent.subject,
            html: followUpContent.html,
            text: followUpContent.text,
            aiProvider: aiProviderUsed,
            sendStatus: 'failed',
            error: sendError
          });

          failedCount++;
          sendSSE(res, { 
            type: 'progress', 
            current: currentNum, 
            total: totalToProcess, 
            email: lead.email, 
            status: 'failed',
            message: `[${currentNum}/${totalToProcess}] Failed to send Follow-up #${nextFollowUpNum} to ${lead.name}: ${sendError}`
          });
        }

        // delay
        if (queue.length > 0) {
          const delayTime = getRandomDelay(30, 90);
          sendSSE(res, { 
            type: 'delay', 
            message: `Waiting for ${delayTime / 1000} seconds before next follow-up...` 
          });
          await sleep(delayTime);
        }
      }
    };

    await Promise.all([runWorker(), runWorker(), runWorker()]);

    sendSSE(res, { 
      type: 'complete', 
      processed: totalToProcess, 
      success: successCount, 
      failed: failedCount 
    });

  } catch (err) {
    logger.error(`Follow-up Batch error: ${err.message}`);
    sendSSE(res, { type: 'error', message: `Server error during follow-up campaign: ${err.message}` });
  }
};
