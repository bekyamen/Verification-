import { z } from 'zod';

const cleanPhone = (val: string) => val.replace(/[\s\-()]/g, '');
const ACCOUNT_TYPES = ["PERSONAL", "BUSINESS"] as const;

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Full name must be at least 2 characters long"),
  phone: z.string().trim()
    .transform(cleanPhone)
    .refine((val) => /^(?:\+251|0)?[97]\d{8}$/.test(val), {
      message: "Please enter a valid Ethiopian phone number (e.g., 0912345678 or +251912345678)",
    }),
  pinCode: z.string().trim()
    .regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
  accountType: z.preprocess(
    (val) => (typeof val === 'string' ? val.trim().toUpperCase() : val),
    z.enum(ACCOUNT_TYPES)
  ),
});

export const loginSchema = z.object({
  phone: z.string().trim()
    .transform(cleanPhone)
    .refine((val) => /^(?:\+251|0)?[97]\d{8}$/.test(val), {
      message: "Please enter a valid Ethiopian phone number (e.g., 0912345678 or +251912345678)",
    }),
  pinCode: z.string().trim()
    .regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

export const cashierLoginSchema = z.object({
  password: z.string().min(1, "Password is required"),
  fullName: z.string().trim().optional(),
  branchId: z.string().trim().optional(),
});
