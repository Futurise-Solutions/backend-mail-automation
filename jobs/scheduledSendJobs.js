const cron = require('node-cron');
const Settings = require('../models/Settings');
const queueService = require('../services/queueService');
const logger = require('../config/logger');

// Tracks the last calendar date (YYYY-MM-DD) each level fired on, so a level
// only sends once per day even though the tick below runs every minute.
const lastRunDate = { initial: null, followup1: null, followup2: null };

const runLevel = async (level, schedule, todayStr, sendFn) => {
  if (!schedule || !schedule.enabled) return;
  const now = new Date();
  if (schedule.hour !== now.getHours() || schedule.minute !== now.getMinutes()) return;
  if (lastRunDate[level] === todayStr) return;

  lastRunDate[level] = todayStr;
  logger.info(`Scheduled send triggered for "${level}" at ${schedule.hour}:${String(schedule.minute).padStart(2, '0')}`);

  try {
    await sendFn();
  } catch (err) {
    logger.error(`Scheduled send for "${level}" failed: ${err.message}`);
  }
};

/**
 * Poll every minute for per-level scheduled sends (initial / followup1 / followup2)
 * configured from Settings, each with its own enable flag and time-of-day.
 */
const initScheduledSendJobs = () => {
  cron.schedule('* * * * *', async () => {
    let settings;
    try {
      settings = await Settings.getSettings();
    } catch (err) {
      logger.error(`Scheduled send: failed to load settings: ${err.message}`);
      return;
    }

    const schedules = settings.schedules;
    if (!schedules) return;

    const todayStr = new Date().toISOString().slice(0, 10);

    await runLevel('initial', schedules.initial, todayStr, () =>
      queueService.processInitialBatch(schedules.initial.batchSize, null, null)
    );
    await runLevel('followup1', schedules.followup1, todayStr, () =>
      queueService.processFollowUpBatch(schedules.followup1.batchSize, null, null, 1)
    );
    await runLevel('followup2', schedules.followup2, todayStr, () =>
      queueService.processFollowUpBatch(schedules.followup2.batchSize, null, null, 2)
    );
  });

  logger.info('Scheduled send jobs initialized (per-level time-of-day polling every minute).');
};

module.exports = initScheduledSendJobs;
