import { Router, Response } from 'express';
import {
  verifyTextPayload,
  verifyImagePayload,
  verifyUrlPayload,
  verifyManualPayload,
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

// Health Check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Flexible upload middleware accepting either 'receipt' or 'file' field name
const uploadReceiptOrFile = (req: any, res: any, next: any) => {
  upload.fields([
    { name: 'receipt', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err: any) => {
    if (err) return next(err);
    if (req.files) {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      req.file = files['receipt']?.[0] || files['file']?.[0];
    }
    next();
  });
};

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
