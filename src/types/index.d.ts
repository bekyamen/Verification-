import { Request } from 'express';
import { Provider } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  role: string;
  branchId?: string | null;
  organizationId: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  cashierId?: string;
}

export interface ExtractedReceiptData {
  txnReference: string | null;
  amount: number | null;
  provider: Provider;
  rawText?: string;
}
