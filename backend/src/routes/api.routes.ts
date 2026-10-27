import { Router, Response } from 'express';
import { verifyTextPayload, verifyImagePayload, verifyUrlPayload, verifyManualPayload } from '../controllers/verification.controller';
import { requireAuth, requireCashierPIN } from '../middleware/auth.middleware';
import { upload } from '../middleware/multer.middleware';
import { generateDailyExcelReport } from '../services/report.service';
import { AuthenticatedRequest } from '../types';

const router = Router();

// Health Check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});


// Verification Endpoints (Used by counter tablets)
// Tablets call POST /auth/cashier-token once at shift start to get an 8-hour JWT,
// then send it as "Authorization: Bearer <token>" on every verify request.
// requireAuth verifies the JWT in < 1 ms — no bcrypt on every scan.
router.post('/verify/text',   requireAuth, verifyTextPayload);
router.post('/verify/image',  requireAuth, upload.single('receipt'), verifyImagePayload);
router.post('/verify/url',    requireAuth, verifyUrlPayload);
router.post('/verify/manual', requireAuth, verifyManualPayload);

// Manager/Owner Reporting Endpoints (Require full JWT auth)
router.get('/reports/daily', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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

// Settings Endpoints
import { getOrganizationAccounts, registerAccount, toggleAccountStatus } from '../controllers/accounts.controller';
import { requireManager } from '../middleware/auth.middleware';

router.get('/settings/accounts', requireAuth, getOrganizationAccounts);
router.post('/settings/accounts', requireAuth, requireManager, registerAccount);
router.patch('/settings/accounts/:id/toggle', requireAuth, requireManager, toggleAccountStatus);

// Provider Status / Health Probe Endpoint (for dashboard and ops monitoring)
import { runStatusProviderProbe, getStatusCapabilities } from '../services/statusProbeService';

router.get('/status/providers', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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
