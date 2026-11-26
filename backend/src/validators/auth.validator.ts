import { z } from 'zod';

const cleanPhone = (val: string) => val.replace(/[\s\-()]/g, '');
const ACCOUNT_TYPES = ["PERSONAL", "BUSINESS"] as const;

export const registerSchema = z.object({
  initData: z.string().min(1, "Telegram session (initData) is required"),
  fullName: z.string().trim()
    .min(2, "Full name must be at least 2 characters")
    .max(60, "Full name must not exceed 60 characters"),
  accountType: z.preprocess(
    (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
    z.enum(["business", "personal"])
  ),
  businessName: z.string().trim().optional(),
  branchCount: z.preprocess(
    (val) => (val !== undefined && val !== null && val !== "" ? Number(val) : undefined),
    z.number().int().min(1, "Number of branches must be at least 1").max(500, "Number of branches cannot exceed 500").optional()
  ),
  contact: z.object({
    phone_number: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    user_id: z.union([z.number(), z.string()]).optional(),
  }).optional(),
}).superRefine((data, ctx) => {
  if (data.accountType === "business") {
    if (!data.businessName || data.businessName.length < 2 || data.businessName.length > 80) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessName"],
        message: "Business name is required (2-80 characters)",
      });
    }
    if (data.branchCount === undefined || isNaN(data.branchCount) || data.branchCount < 1 || data.branchCount > 500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branchCount"],
        message: "Number of branches is required (integer 1-500)",
      });
    }
  }
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
