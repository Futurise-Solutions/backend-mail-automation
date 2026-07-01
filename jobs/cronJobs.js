const cron = require('node-cron');
const Lead = require('../models/Lead');
const logger = require('../config/logger');

/**
 * Configure and initialize daily background tasks.
 */
const initCronJobs = () => {
  // Run every day at midnight (00:00)
  cron.schedule('0 0 * * *', async () => {
    logger.info('Running daily cron job for lead status transitions...');
    
    try {
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

      // Find leads that are in 'FOLLOWUP_2_SENT', have no reply, and last follow-up was sent > 10 days ago
      const leadsToMarkInactive = await Lead.find({
        status: 'FOLLOWUP_2_SENT',
        replyReceived: false,
        lastFollowupAt: { $lt: tenDaysAgo }
      });

      if (leadsToMarkInactive.length > 0) {
        logger.info(`Found ${leadsToMarkInactive.length} leads to transition to INACTIVE.`);
        
        for (const lead of leadsToMarkInactive) {
          lead.status = 'INACTIVE';
          lead.inactiveAt = new Date();
          await lead.save();
          logger.info(`Lead ${lead.email} is now INACTIVE (no reply 10 days post-Followup 2)`);
        }
      } else {
        logger.info('No leads found requiring INACTIVE transition.');
      }
    } catch (err) {
      logger.error(`Error in daily cron execution: ${err.message}`);
    }
  });

  logger.info('Daily status check scheduler initialized.');
};

module.exports = initCronJobs;
