const cron = require('node-cron');
const logger = require('../config/logger');
const { markStaleLeadsInactive } = require('./inactiveSweep');

/**
 * Configure and initialize daily background tasks.
 *
 * NOTE: This only runs when the process stays alive AND ENABLE_INPROCESS_CRON=true
 * (see server.js). When deploying to a free/sleeping host, the same work is run by
 * an external scheduler instead — scripts/runScheduledSend.js via GitHub Actions.
 */
const initCronJobs = () => {
  // Run every day at midnight (00:00, server local time)
  cron.schedule('0 0 * * *', async () => {
    logger.info('Running daily cron job for lead status transitions...');
    try {
      await markStaleLeadsInactive();
    } catch (err) {
      logger.error(`Error in daily cron execution: ${err.message}`);
    }
  });

  logger.info('Daily status check scheduler initialized.');
};

module.exports = initCronJobs;
