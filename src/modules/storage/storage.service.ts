import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { s3Client, S3_BUCKET } from '../../config/s3';
import { waService } from '../whatsapp/whatsapp.service';
import { AppError, asyncHandler } from '../../lib/errors';
import { success, created } from '../../lib/response';
import prisma from '../../config/database';

// ── Service ───────────────────────────────────────────────────────────────────

export class StorageService {
  /**
   * Upload a Buffer to S3.
   * Returns the public URL.
   */
  async uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: string,
    isPublic = false
  ): Promise<string> {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ...(isPublic && { ACL: 'public-read' }),
      })
    );

    return `https://${S3_BUCKET}.s3.${process.env.AWS_REGION ?? 'ap-south-1'}.amazonaws.com/${key}`;
  }

  /**
   * Download an S3 object and return it as a Buffer.
   * Used by the Excel import worker.
   */
  async downloadToBuffer(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    const response = await s3Client.send(command);

    if (!response.Body) throw new AppError('S3 object body is empty', 500);

    const stream = response.Body as Readable;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /**
   * Generate a pre-signed URL for temporary direct access.
   * Useful for serving private files to authenticated users.
   */
  async getPresignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Delete a file from S3.
   */
  async deleteFile(key: string): Promise<void> {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  }

  /**
   * Check if a key exists in S3.
   */
  async exists(key: string): Promise<boolean> {
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Full media pipeline:
   * 1. Upload file buffer to S3
   * 2. Upload same buffer to WhatsApp Media API
   * 3. Store MediaAsset record with both URLs
   * 4. Return the asset record
   *
   * This is the single entry point for all media that will be used in WA messages.
   */
  async uploadMediaAsset(
    tenantId: string,
    file: Express.Multer.File,
    folder: 'messages' | 'catalog' | 'templates' = 'messages'
  ) {
    const ext = file.originalname.split('.').pop() ?? 'bin';
    const s3Key = `${folder}/${tenantId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    // 1. S3 upload
    const s3Url = await this.uploadBuffer(file.buffer, s3Key, file.mimetype);

    // 2. WhatsApp Media upload (non-fatal if fails)
    let waMediaId: string | undefined;
    try {
      waMediaId = await waService.uploadMedia(
        tenantId,
        file.buffer,
        file.originalname,
        file.mimetype
      );
    } catch (err) {
      console.warn(`WA media upload failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // 3. Store asset record
    const asset = await prisma.mediaAsset.create({
      data: {
        tenant_id: tenantId,
        file_name: file.originalname,
        file_type: resolveFileType(file.mimetype),
        mime_type: file.mimetype,
        s3_key: s3Key,
        s3_url: s3Url,
        wa_media_id: waMediaId,
        file_size: file.size,
      },
    });

    return asset;
  }

  async listAssets(tenantId: string, fileType?: string) {
    return prisma.mediaAsset.findMany({
      where: {
        tenant_id: tenantId,
        ...(fileType && { file_type: fileType }),
      },
      orderBy: { uploaded_at: 'desc' },
    });
  }

  async deleteAsset(tenantId: string, assetId: string) {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: assetId, tenant_id: tenantId },
    });
    if (!asset) throw new AppError('Asset not found', 404);

    await this.deleteFile(asset.s3_key);
    await prisma.mediaAsset.delete({ where: { id: assetId } });
  }
}

export const storageService = new StorageService();

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveFileType(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('spreadsheet'))
    return 'document';
  return 'other';
}

// ── Routes ────────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/3gpp',
  'audio/mpeg', 'audio/ogg', 'audio/aac',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB (WA limit)
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(`File type ${file.mimetype} is not allowed`, 400));
    }
  },
});

const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { type } = z.object({ type: z.string().optional() }).parse(req.query);
  const assets = await storageService.listAssets(req.tenantId, type);
  return success(res, assets);
}));

router.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw new AppError('No file provided', 400);

    const { folder } = z
      .object({ folder: z.enum(['messages', 'catalog', 'templates']).default('messages') })
      .parse(req.body);

    const asset = await storageService.uploadMediaAsset(req.tenantId, req.file, folder);
    return created(res, asset, 'File uploaded successfully');
  })
);

router.get('/:id/presigned', asyncHandler(async (req: Request, res: Response) => {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: req.params.id, tenant_id: req.tenantId },
  });
  if (!asset) throw new AppError('Asset not found', 404);

  const url = await storageService.getPresignedUrl(asset.s3_key);
  return success(res, { url, expires_in: 3600 });
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await storageService.deleteAsset(req.tenantId, req.params.id);
  return success(res, null, 'Asset deleted');
}));

export default router;
