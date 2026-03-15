import cron from 'node-cron';
import { leadsService } from './modules/leads/leads.service';
import { followupsService } from './modules/followups/followups.service';
import prisma from './config/database';

export function startCronJobs(): void {
  // Every hour: expire cooling leads whose cooling_until has passed
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await leadsService.expireCoolingLeads();
      if (result.count > 0) {
        console.log(`⏰ Cron: ${result.count} cooling leads moved back to PENDING`);
      }
    } catch (err) {
      console.error('Cron cooling expiry error:', err);
    }
  });

  // Every 6 hours: mark unanswered followups as NO_REPLY; dead if stage 3
  cron.schedule('0 */6 * * *', async () => {
    try {
      const result = await followupsService.expireFollowups(48);
      if (result.expired > 0) {
        console.log(`⏰ Cron: ${result.expired} followups marked NO_REPLY`);
      }
    } catch (err) {
      console.error('Cron followup expiry error:', err);
    }
  });

  // Midnight: reset daily message counts for all tenants
  cron.schedule('0 0 * * *', async () => {
    try {
      const result = await prisma.tenant.updateMany({
        data: { messages_sent_today: 0, messages_reset_at: new Date() },
      });
      console.log(`⏰ Cron: Daily message counts reset for ${result.count} tenants`);
    } catch (err) {
      console.error('Cron daily reset error:', err);
    }
  });

  console.log('⏰ Cron jobs started');
}
