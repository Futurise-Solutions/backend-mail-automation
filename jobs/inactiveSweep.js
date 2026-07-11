const Lead = require('../models/Lead');
const logger = require('../config/logger');

/**
 * Transition leads that have been sitting in FOLLOWUP_2_SENT with no reply
 * for more than 10 days into INACTIVE.
 *
 * Shared by the in-process cron (jobs/cronJobs.js) and the external runner
 * (scripts/runScheduledSend.js), so both paths behave identically.
 *
 * @returns {Promise<number>} number of leads transitioned to INACTIVE
 */
const markStaleLeadsInactive = async () => {
  const tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

  // Find leads in 'FOLLOWUP_2_SENT', with no reply, whose last follow-up was > 10 days ago
  const leadsToMarkInactive = await Lead.find({
    status: 'FOLLOWUP_2_SENT',
    replyReceived: false,
    lastFollowupAt: { $lt: tenDaysAgo }
  });

  if (leadsToMarkInactive.length === 0) {
    logger.info('No leads found requiring INACTIVE transition.');
    return 0;
  }

  logger.info(`Found ${leadsToMarkInactive.length} leads to transition to INACTIVE.`);

  for (const lead of leadsToMarkInactive) {
    lead.status = 'INACTIVE';
    lead.inactiveAt = new Date();
    await lead.save();
    logger.info(`Lead ${lead.email} is now INACTIVE (no reply 10 days post-Followup 2)`);
  }

  return leadsToMarkInactive.length;
};

module.exports = { markStaleLeadsInactive };
