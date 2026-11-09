-- AlterTable
ALTER TABLE "VerificationRecord" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "BankSettlementAccount_organizationId_isActive_idx" ON "BankSettlementAccount"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "VerificationRecord_branchId_createdAt_idx" ON "VerificationRecord"("branchId", "createdAt");
