#!/usr/bin/env node
/**
 * Headless scheduled-send runner for GitHub Actions (or any external cron).
 *
 * This runs the SAME queue/send logic the server uses, but as a one-shot process
 * with no HTTP/SSE. It reads all config (Mongo URI, AI keys, SMTP/Resend creds,
 * daily limit, batch sizes, signature) from the SAME MongoDB Settings document +
 * environment variables that server.js uses — so it behaves identically in CI.
 *
 * Usage:
 *   node scripts/runScheduledSend.js <level> [--dry-run] [--count=N]
 *
 *   <level>      initial | followup1 | followup2 | inactive   (default: initial)
 *   --dry-run    connect + report how many leads WOULD be processed; send nothing
 *   --count=N    override batch size (otherwise read from Settings.schedules.<level>.batchSize)
 *
 * Exit codes: 0 = ok, 1 = runtime error, 2 = bad arguments.
 */

const path = require('path');
const fs = require('fs');

// Winston writes to ../logs, which is gitignored and therefore absent on a fresh
// CI checkout. Create it up-front so the File transports don't error on first write.
fs.mkdirSync(path.join(__dirname, '..', 'logs'), { recursive: true });

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const logger = require('../config/logger');
const Settings = require('../models/Settings');
const Lead = require('../models/Lead');
const queueService = require('../services/queueService');
const { markStaleLeadsInactive } = require('../jobs/inactiveSweep');

const VALID_LEVELS = ['initial', 'followup1', 'followup2', 'inactive'];

const parseArgs = () => {
  const args = process.argv.slice(2);
  const level = (args.find((a) => !a.startsWith('--')) || 'initial').toLowerCase();
  const dryRun = args.includes('--dry-run');
  const countArg = args.find((a) => a.startsWith('--count='));
  const count = countArg ? parseInt(countArg.split('=')[1], 10) : null;
  return { level, dryRun, count };
};

// How many leads are currently eligible for a given level (for --dry-run reporting).
const countEligible = async (level) => {
  if (level === 'initial') {
    return Lead.countDocuments({ status: { $in: ['FRESH', 'SKIPPED', 'AI_FAILED', 'EMAIL_FAILED'] } });
  }
  if (level === 'followup1') {
    return Lead.countDocuments({ status: 'EMAIL_SENT', followupCount: 0, replyReceived: false });
  }
  if (level === 'followup2') {
    return Lead.countDocuments({ status: 'FOLLOWUP_1_SENT', followupCount: 1, replyReceived: false });
  }
  if (level === 'inactive') {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    return Lead.countDocuments({
      status: 'FOLLOWUP_2_SENT',
      replyReceived: false,
      lastFollowupAt: { $lt: tenDaysAgo }
    });
  }
  return 0;
};

const closeDb = async () => {
  try {
    await mongoose.connection.close();
  } catch (_) {
    /* ignore close errors */
  }
};

(async () => {
  const { level, dryRun, count } = parseArgs();

  if (!VALID_LEVELS.includes(level)) {
    // eslint-disable-next-line no-console
    console.error(`Invalid level "${level}". Use one of: ${VALID_LEVELS.join(', ')}`);
    process.exit(2);
  }

  logger.info(`=== Scheduled runner starting: level="${level}"${dryRun ? ' (DRY RUN)' : ''} ===`);

  try {
    await connectDB();

    // Resolve batch size for send levels (inactive ignores it).
    let batchSize = count;
    if (batchSize == null && level !== 'inactive') {
      const settings = await Settings.getSettings();
      const sched = settings.schedules && settings.schedules[level];
      batchSize = (sched && sched.batchSize) || 20;
    }

    if (dryRun) {
      const eligible = await countEligible(level);
      const wouldProcess = level === 'inactive' ? eligible : Math.min(batchSize, eligible);
      logger.info(
        `[DRY RUN] level="${level}" — eligible pool: ${eligible}, would process up to ${wouldProcess}. Nothing was sent.`
      );
      await closeDb();
      process.exit(0);
    }

    switch (level) {
      case 'initial':
        // (count, res=null -> no SSE, ids=null -> auto-select FRESH/SKIPPED/…)
        await queueService.processInitialBatch(batchSize, null, null);
        break;
      case 'followup1':
        await queueService.processFollowUpBatch(batchSize, null, null, 1);
        break;
      case 'followup2':
        await queueService.processFollowUpBatch(batchSize, null, null, 2);
        break;
      case 'inactive':
        await markStaleLeadsInactive();
        break;
    }

    logger.info(`=== Scheduled runner finished: level="${level}" ===`);
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error(`Scheduled runner failed (level="${level}"): ${err.message}`, { stack: err.stack });
    await closeDb();
    process.exit(1);
  }
})();
