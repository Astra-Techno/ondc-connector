const { startCatalogSync }   = require('./catalogSync.job');
const { startInventorySync } = require('./inventorySync.job');
const { startOrderSync }     = require('./orderSync.job');
const logger = require('../utils/logger');

let cron;
try { cron = require('node-cron'); } catch (e) { cron = null; }

const startAllJobs = () => {
  logger.info('Starting background scheduler jobs...');

  startCatalogSync();    // every 30 min
  startInventorySync();  // every 15 min
  startOrderSync();      // every 5 min

  // Daily settlements at midnight
  if (cron) {
    cron.schedule('0 0 * * *', async () => {
      try {
        const { generateDailySettlements } = require('../services/settlement.service');
        await generateDailySettlements();
      } catch (e) {
        logger.error('[Settlement] Daily job failed:', e.message);
      }
    });
    logger.info('[Settlement] Daily settlement job scheduled (00:00)');
  }

  logger.info('All scheduler jobs started');
};

module.exports = { startAllJobs };
