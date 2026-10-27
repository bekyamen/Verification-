import { z } from 'zod';
import { parseReceiptLink } from '../services/receiptLink';

export const verifyTextSchema = z.object({
  rawText: z.string().min(5),
  expectedAmount: z.number().positive().optional(),
});

export const reportQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const verifyUrlSchema = z.object({
  receiptUrl: z
    .string()
    .url('Must be a valid URL')
    .refine(
      (u) => parseReceiptLink(u) !== null,
      { message: 'URL must be a recognised CBE or Telebirr receipt link (HTTPS only).' }
    ),
  expectedAmount: z.number().positive().optional(),
});

// Manual verification is restricted to CBE and Telebirr only.
// Receiver account comes from the database; do not accept it from the client.
export const verifyManualSchema = z.object({
  provider: z.enum(['CBE', 'TELEBIRR'], {
    error: 'Only CBE and Telebirr manual verification is supported.',
  }),
  txnReference: z.string().min(3, 'Transaction reference required'),
  amount: z.number().positive().optional(),
  expectedAmount: z.number().positive().optional(),
  payerPhone: z.string().optional(),
});

