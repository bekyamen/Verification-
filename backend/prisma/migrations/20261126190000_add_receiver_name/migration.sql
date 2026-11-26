-- AlterTable: Add receiverName to VerificationRecord
ALTER TABLE "VerificationRecord" 
  ADD COLUMN IF NOT EXISTS "receiverName" TEXT NULL;
