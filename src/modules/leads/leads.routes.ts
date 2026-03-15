import { Router } from 'express';
import multer from 'multer';
import * as leadsController from './leads.controller';
import { uploadRateLimiter } from '../../middleware/rateLimiter';

const router = Router();

// In-memory storage: we upload to S3 ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Tags management
router.get('/', leadsController.listLeads);
router.post('/', leadsController.createLead);
router.put('/bulk', leadsController.bulkUpdateLeads);

// Upload
router.post(
  '/upload',
  uploadRateLimiter,
  upload.single('file'),
  leadsController.uploadLeads
);
router.get('/upload/:uploadId', leadsController.getUploadStatus);

// Single lead CRUD
router.get('/:id', leadsController.getLead);
router.put('/:id', leadsController.updateLead);
router.delete('/:id', leadsController.deleteLead);

// Tags
router.post('/:id/tags', leadsController.addTag);
router.delete('/:id/tags/:tagId', leadsController.removeTag);

export default router;
