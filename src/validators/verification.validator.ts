import { z } from 'zod';

export const verifyTextSchema = z.object({
  rawText: z.string().min(5),
  expectedAmount: z.number().positive().optional(),
});

export const reportQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const verifyUrlSchema = z.object({
  receiptUrl: z.string().url("Must be a valid URL"),
  expectedAmount: z.number().positive().optional(),
});

// Advanced conditional schema using superRefine
export const verifyManualSchema = z.object({
  provider: z.enum(["CBE", "TELEBIRR", "DASHEN", "AWASH", "BOA", "ZEMEN", "CBE_BIRR", "MPESA", "SIINQEE", "OTHER", "UNKNOWN"]),
  txnReference: z.string().min(3, "Transaction reference required"),
  amount: z.number().positive().optional(),
  expectedAmount: z.number().positive().optional(),
  
  // Optional extension fields mapped safely
  receivingAccount: z.string().optional(),
  receivingPhoneNumber: z.string().optional(),
  senderAccount: z.string().optional(),
  payerPhone: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.provider === 'CBE') {
    if (!data.receivingAccount || data.receivingAccount.length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivingAccount'],
        message: 'CBE payments require a receiving account of at least 10 digits.'
      });
    }
  }

  if (data.provider === 'BOA') {
    if (!data.senderAccount || data.senderAccount.length < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['senderAccount'],
        message: 'BOA payments require a sender account of at least 5 digits (unless URL provides it).'
      });
    }
  }

  if (data.provider === 'CBE_BIRR') {
    if (!data.payerPhone || !/^251[79]\d{8}$/.test(data.payerPhone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payerPhone'],
        message: 'CBE Birr payments require a payer phone matching 251XXXXXXXXX.'
      });
    }
  }
});
