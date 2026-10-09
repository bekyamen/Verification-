import { z } from 'zod';
import { BankName } from '@prisma/client';

export const registerAccountSchema = z.object({
  bankName: z.nativeEnum(BankName, { message: "Invalid bank name. Expected CBE, TELEBIRR, BOA, AWASH, etc." }),
  accountNumber: z.string().min(5, "Account number must be at least 5 digits"),
  accountHolderName: z.string().min(3, "Account holder name must be at least 3 characters"),
}).superRefine((data, ctx) => {
  if (data.bankName === 'CBE' && data.accountNumber.replace(/[^0-9]/g, '').length < 13) {
      ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accountNumber'],
          message: 'CBE requires a 13-digit receiving account number.',
      });
  }
  if (data.bankName === 'TELEBIRR') {
      const phone = data.accountNumber.replace(/[^0-9]/g, '');
      if (phone.length < 9) {
          ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['accountNumber'],
              message: 'Telebirr requires a valid phone number.',
          });
      }
  }
});
