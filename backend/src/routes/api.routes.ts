import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  verifyTextPayload,
  verifyImagePayload,
  verifyUrlPayload,
  verifyManualPayload,
  verifyReceiptPayProof,
  getVerificationHistory,
} from '../controllers/verification.controller';
import { requireAuth, requireAdmin } from '../middleware/auth.middleware';
import { upload } from '../middleware/multer.middleware';
import { generateDailyExcelReport } from '../services/report.service';
import { AuthenticatedRequest } from '../types';
import {
  getOrganizationAccounts,
  registerAccount,
  updateAccount,
  deleteAccount,
  toggleAccountStatus,
} from '../controllers/accounts.controller';
import { runStatusProviderProbe, getStatusCapabilities } from '../services/statusProbeService';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Optional auth: attaches req.user if Bearer token present, but does not block unauthenticated requests
const optionalAuth = (req: any, _res: any, next: any) => {
  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
    } catch {
      // Ignore invalid or expired token for optional auth routes
    }
  }
  next();
};

// Health Check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Flexible upload middleware accepting receipt, file, image, images[], or any file field
const uploadReceiptOrFile = (req: any, res: any, next: any) => {
  upload.any()(req, res, (err: any) => {
    if (err) {
      if (err.message && err.message.includes('Unexpected end of form')) {
        res.status(400).json({
          success: false,
          verified: false,
          error: 'Upload stream interrupted: Unexpected end of form.',
          hint: 'In Postman: Go to the "Headers" tab and UNCHECK "Content-Type" so Postman automatically generates the boundary. Under the "Body" tab, select "form-data", set key to "receipt" or "images[]", hover over the key to switch type from "Text" to "File", and select your receipt image.',
        });
        return;
      }
      return next(err);
    }
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      // Find by preferred field names or take the first file
      req.file =
        req.files.find((f: any) => f.fieldname === 'images[]') ||
        req.files.find((f: any) => f.fieldname === 'receipt') ||
        req.files.find((f: any) => f.fieldname === 'file') ||
        req.files.find((f: any) => f.fieldname === 'image') ||
        req.files[0];
    }
    next();
  });
};

// ── PayProof Telebirr-Only Verification Endpoints ────────────────────────────
// Accepts receipt image ("images[]", "receipt", "file"), forwards to PayProof, polls & validates
router.post('/verify-receipt', optionalAuth, uploadReceiptOrFile, verifyReceiptPayProof);
router.post('/verify/telebirr', optionalAuth, uploadReceiptOrFile, verifyReceiptPayProof);

// ── Verification Endpoints (Accessible by both Cashier and Admin) ─────────────
router.get('/verify/history', requireAuth, getVerificationHistory);
router.post('/verify/text',   requireAuth, verifyTextPayload);
router.post('/verify/image',  requireAuth, uploadReceiptOrFile, verifyImagePayload);
router.post('/verify/url',    requireAuth, verifyUrlPayload);
router.post('/verify/manual', requireAuth, verifyManualPayload);

// ── Receiving Accounts Endpoints (Admin Only) ─────────────────────────────────
router.get('/settings/accounts',              requireAuth, requireAdmin, getOrganizationAccounts);
router.post('/settings/accounts',             requireAuth, requireAdmin, registerAccount);
router.patch('/settings/accounts/:id',        requireAuth, requireAdmin, updateAccount);
router.delete('/settings/accounts/:id',       requireAuth, requireAdmin, deleteAccount);
router.patch('/settings/accounts/:id/toggle', requireAuth, requireAdmin, toggleAccountStatus);

// ── Manager/Owner Reporting Endpoints (Admin Only) ────────────────────────────
router.get('/reports/daily', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const user = req.user;
  if (!user || !user.branchId) {
    res.status(403).json({ error: 'Permission denied. Branch ID required.' });
    return;
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    await generateDailyExcelReport(user.branchId, today, tomorrow, res);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ── Provider Status / Health Probe Endpoint (Admin Only) ──────────────────────
router.get('/status/providers', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [cbeResult, cbeNewResult, telebirrResult] = await Promise.allSettled([
      runStatusProviderProbe('cbe'),
      runStatusProviderProbe('cbe-new'),
      runStatusProviderProbe('telebirr'),
    ]);

    const capabilities = getStatusCapabilities();

    res.json({
      checkedAt: new Date().toISOString(),
      capabilities,
      providers: {
        cbe: cbeResult.status === 'fulfilled' ? cbeResult.value : { error: (cbeResult as any).reason?.message },
        'cbe-new': cbeNewResult.status === 'fulfilled' ? cbeNewResult.value : { error: (cbeNewResult as any).reason?.message },
        telebirr: telebirrResult.status === 'fulfilled' ? telebirrResult.value : { error: (telebirrResult as any).reason?.message },
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to probe provider status', details: error.message });
  }
});

export default router;
