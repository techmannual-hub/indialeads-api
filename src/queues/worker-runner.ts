import './config/env'; // validate env first
import { createBroadcastWorker } from './queues/workers/broadcast.worker';
import { createWhatsappWorker } from './queues/workers/whatsapp.worker';
import { createLeadImportWorker } from './queues/workers/leadImport.worker';
import { createAutomationWorker } from './queues/workers/automation.worker';
import { initSocket } from './socket';
import http from 'http';

// Workers need Socket.io to emit progress events.
// We create a minimal HTTP server just for the socket connection.
const server = http.createServer();
initSocket(server);

const workers = [
  createBroadcastWorker(),
  createWhatsappWorker(),
  createLeadImportWorker(),
  createAutomationWorker(),
];

console.log(`🚀 ${workers.length} BullMQ workers started`);

async function shutdown() {
  console.log('⏳ Gracefully shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  console.log('👋 Workers stopped');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
