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
// Using requireCashierPIN to quickly authenticate shared tablet connections
router.post('/verify/text', requireCashierPIN, verifyTextPayload);
router.post('/verify/image', requireCashierPIN, upload.single('receipt'), verifyImagePayload);
router.post('/verify/url', requireCashierPIN, verifyUrlPayload);
router.post('/verify/manual', requireCashierPIN, verifyManualPayload);

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

export default router;
