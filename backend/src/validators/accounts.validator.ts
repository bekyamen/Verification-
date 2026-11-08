import { z } from 'zod';
import { BankName } from '@prisma/client';

export const registerAccountSchema = z.object({
  bankName: z.preprocess(
    (val) => (typeof val === 'string' ? val.trim().toUpperCase() : val),
    z.nativeEnum(BankName, { message: "Bank must be CBE or TELEBIRR" })
  ),
  accountNumber: z.string().trim().min(5, "Account number is required"),
  accountHolderName: z.string().trim().min(2, "Account holder name must be at least 2 characters"),
}).superRefine((data, ctx) => {
  const digits = data.accountNumber.replace(/[^0-9]/g, '');

  if (data.bankName === 'CBE') {
    if (digits.length !== 13) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountNumber'],
        message: 'CBE requires a 13-digit receiving account number (e.g. 1000123456789).',
      });
    }
  }

  if (data.bankName === 'TELEBIRR') {
    const raw = data.accountNumber.trim().replace(/[\s\-()]/g, '');
    const isValidPhone = /^(09|07)\d{8}$/.test(raw) || /^\+251(9|7)\d{8}$/.test(raw);
    if (!isValidPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountNumber'],
        message: 'Telebirr account must be a valid Ethiopian phone number (e.g. 0912345678 or +251912345678).',
      });
    }
  }
});

export const updateAccountSchema = z.object({
  accountHolderName: z.string().trim().min(2, "Account holder name must be at least 2 characters").optional(),
  isActive: z.boolean().optional(),
}).refine((data) => data.accountHolderName !== undefined || data.isActive !== undefined, {
  message: "Provide either accountHolderName or isActive to update",
});
