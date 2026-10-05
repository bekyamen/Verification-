/*
  Warnings:

  - The values [CBE_MOBILE] on the enum `Provider` will be removed. If these variants are still used in the database, this will fail.
  - A unique constraint covering the columns `[branchId,provider,txnReference]` on the table `VerificationRecord` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Provider_new" AS ENUM ('CBE', 'TELEBIRR', 'DASHEN', 'AWASH', 'BOA', 'ZEMEN', 'CBE_BIRR', 'MPESA', 'SIINQEE', 'OTHER', 'UNKNOWN');
ALTER TABLE "VerificationRecord" ALTER COLUMN "provider" TYPE "Provider_new" USING ("provider"::text::"Provider_new");
ALTER TYPE "Provider" RENAME TO "Provider_old";
ALTER TYPE "Provider_new" RENAME TO "Provider";
DROP TYPE "Provider_old";
COMMIT;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VerificationStatus" ADD VALUE 'INVALID_RECEIPT';
ALTER TYPE "VerificationStatus" ADD VALUE 'FAILED_UPSTREAM';

-- DropIndex
DROP INDEX "VerificationRecord_branchId_txnReference_key";

-- AlterTable
ALTER TABLE "VerificationRecord" ADD COLUMN     "payerPhone" TEXT,
ADD COLUMN     "receiptImageUrl" TEXT,
ADD COLUMN     "receiptUrl" TEXT,
ADD COLUMN     "receivingAccount" TEXT,
ADD COLUMN     "senderAccount" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "VerificationRecord_branchId_provider_txnReference_key" ON "VerificationRecord"("branchId", "provider", "txnReference");
