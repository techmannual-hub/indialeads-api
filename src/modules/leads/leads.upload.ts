import * as XLSX from 'xlsx';
import prisma from '../../config/database';
import { leadsService } from './leads.service';
import { storageService } from '../storage/storage.service';
import { getIo } from '../../socket';

interface ExcelRow {
  name?: string;
  phone?: string;
  product?: string;
  // allow any extra columns
  [key: string]: unknown;
}

// Normalize column header: "Phone Number" → "phone", "Product Name" → "product"
function normalizeHeader(header: string): string {
  return header.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
}

function findColumn(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = Object.keys(row).find(
      (k) => normalizeHeader(k) === key || normalizeHeader(k).includes(key)
    );
    if (found && row[found] != null) return String(row[found]).trim();
  }
  return undefined;
}

export async function processLeadUpload(
  tenantId: string,
  uploadId: string,
  s3Key: string
): Promise<void> {
  const io = getIo();

  // Update status to PROCESSING
  await prisma.leadUpload.update({
    where: { id: uploadId },
    data: { status: 'PROCESSING' },
  });

  let stats = { total: 0, imported: 0, updated: 0, skipped: 0, failed: 0 };
  const errorLog: { row: number; reason: string }[] = [];

  try {
    // Download file from S3
    const buffer = await storageService.downloadToBuffer(s3Key);

    // Parse Excel
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: ExcelRow[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    stats.total = rows.length;

    // Update total count
    await prisma.leadUpload.update({
      where: { id: uploadId },
      data: { total_rows: rows.length },
    });

    // Process rows in batches of 50
    const BATCH_SIZE = 50;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (row, batchIndex) => {
          const rowNum = i + batchIndex + 2; // +2: 1-based + header row
          const name = findColumn(row, 'name', 'full_name', 'customer_name');
          const phone = findColumn(row, 'phone', 'mobile', 'contact', 'number', 'phone_number', 'mobile_number');
          const product = findColumn(row, 'product', 'product_name', 'item', 'service');

          if (!name || !phone) {
            stats.failed++;
            errorLog.push({ row: rowNum, reason: 'Missing required fields: name or phone' });
            return;
          }

          const result = await leadsService.upsertFromUpload(tenantId, uploadId, {
            name,
            phone,
            product,
          });

          if (result === 'created') stats.imported++;
          else if (result === 'updated') stats.updated++;
          else if (result === 'skipped') stats.skipped++;
          else {
            stats.failed++;
            errorLog.push({ row: rowNum, reason: 'Invalid phone number' });
          }
        })
      );

      // Emit progress to tenant's socket room
      const progress = Math.round(((i + batch.length) / rows.length) * 100);
      io.to(`tenant:${tenantId}`).emit('lead_import:progress', {
        uploadId,
        progress,
        ...stats,
      });
    }

    // Mark complete
    await prisma.leadUpload.update({
      where: { id: uploadId },
      data: {
        status: 'DONE',
        imported: stats.imported,
        updated: stats.updated,
        skipped: stats.skipped,
        failed: stats.failed,
        error_log: errorLog.length > 0 ? errorLog : undefined,
        completed_at: new Date(),
      },
    });

    io.to(`tenant:${tenantId}`).emit('lead_import:complete', { uploadId, ...stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await prisma.leadUpload.update({
      where: { id: uploadId },
      data: {
        status: 'FAILED',
        error_log: [{ row: 0, reason: message }],
        completed_at: new Date(),
      },
    });
    io.to(`tenant:${tenantId}`).emit('lead_import:failed', { uploadId, error: message });
    throw err;
  }
}
