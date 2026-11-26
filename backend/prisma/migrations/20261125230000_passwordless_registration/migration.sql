-- AlterEnum: Add USER to Role enum if not exists
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'USER';

-- AlterTable: Make passwordHash and pinCode nullable on User
ALTER TABLE "User" 
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ALTER COLUMN "pinCode" DROP NOT NULL;

-- AlterTable: Add account_type, business_name, branch_count, telegram_user_id to User
ALTER TABLE "User" 
  ADD COLUMN IF NOT EXISTS "account_type" TEXT NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS "business_name" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "branch_count" INTEGER NULL,
  ADD COLUMN IF NOT EXISTS "telegram_user_id" BIGINT NULL;

-- Create Unique Index on telegram_user_id
CREATE UNIQUE INDEX IF NOT EXISTS "User_telegram_user_id_key" ON "User"("telegram_user_id");

-- Create telegram_contacts table for bot-stored contacts
CREATE TABLE IF NOT EXISTS "telegram_contacts" (
  "telegram_user_id" BIGINT PRIMARY KEY,
  "phone_number" TEXT NOT NULL,
  "first_name" TEXT NULL,
  "last_name" TEXT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
