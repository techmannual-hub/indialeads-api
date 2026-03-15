import { Queue, QueueOptions } from 'bullmq';
import { createRedisConnection } from './redis';

const defaultQueueOptions: Partial<QueueOptions> = {
  connection: createRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
};

// Queue names as constants to avoid typos
export const QUEUE_NAMES = {
  WHATSAPP_MESSAGES: 'whatsapp-messages',
  BROADCAST_PROCESSOR: 'broadcast-processor',
  AUTOMATION_RUNNER: 'automation-runner',
  LEAD_IMPORTER: 'lead-importer',
} as const;

// Singleton queues
let whatsappQueue: Queue | null = null;
let broadcastQueue: Queue | null = null;
let automationQueue: Queue | null = null;
let leadImportQueue: Queue | null = null;

export function getWhatsappQueue(): Queue {
  if (!whatsappQueue) {
    whatsappQueue = new Queue(QUEUE_NAMES.WHATSAPP_MESSAGES, {
      ...defaultQueueOptions,
      connection: createRedisConnection(),
    });
  }
  return whatsappQueue;
}

export function getBroadcastQueue(): Queue {
  if (!broadcastQueue) {
    broadcastQueue = new Queue(QUEUE_NAMES.BROADCAST_PROCESSOR, {
      ...defaultQueueOptions,
      connection: createRedisConnection(),
    });
  }
  return broadcastQueue;
}

export function getAutomationQueue(): Queue {
  if (!automationQueue) {
    automationQueue = new Queue(QUEUE_NAMES.AUTOMATION_RUNNER, {
      ...defaultQueueOptions,
      connection: createRedisConnection(),
    });
  }
  return automationQueue;
}

export function getLeadImportQueue(): Queue {
  if (!leadImportQueue) {
    leadImportQueue = new Queue(QUEUE_NAMES.LEAD_IMPORTER, {
      ...defaultQueueOptions,
      connection: createRedisConnection(),
    });
  }
  return leadImportQueue;
}
