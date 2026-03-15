import { Worker, Job } from 'bullmq';
import { createRedisConnection } from '../../config/redis';
import { QUEUE_NAMES } from '../../config/queues';
import { AutomationJobData } from '../../types';
import { automationsService } from '../../modules/automations/automations.service';

export function createAutomationWorker(): Worker {
  const worker = new Worker<AutomationJobData>(
    QUEUE_NAMES.AUTOMATION_RUNNER,
    async (job: Job<AutomationJobData>) => {
      const { tenantId, automationId, leadId, context } = job.data;
      await automationsService.execute(tenantId, automationId, leadId, context);
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`❌ Automation job ${job?.id} failed:`, err.message);
  });

  return worker;
}
