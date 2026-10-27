import { z } from 'zod';

export const registerSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters long"),
  phone: z.string()
    .min(9, "Phone number is too short")
    .regex(/^(?:\+251|0)?[97]\d{8}$/, "Invalid Ethiopian phone number format"),
  pinCode: z.string().min(4, "PIN must be at least 4 digits long"),
  accountType: z.enum(["PERSONAL", "BUSINESS"]),
});

export const loginSchema = z.object({
  phone: z.string().min(9),
  pinCode: z.string().min(4),
});
