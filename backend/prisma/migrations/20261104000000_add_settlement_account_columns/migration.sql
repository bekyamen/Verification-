-- Add missing columns to BankSettlementAccount
ALTER TABLE "BankSettlementAccount"
  ADD COLUMN IF NOT EXISTS "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "createdById" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedById" TEXT,
  ADD COLUMN IF NOT EXISTS "isActive"    BOOLEAN NOT NULL DEFAULT true;

-- Backfill updatedAt so the NOT NULL constraint is satisfied for existing rows
-- (DEFAULT CURRENT_TIMESTAMP above handles this, but explicit is safer)

-- AddForeignKey: createdBy -> User
ALTER TABLE "BankSettlementAccount"
  ADD CONSTRAINT "BankSettlementAccount_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: updatedBy -> User
ALTER TABLE "BankSettlementAccount"
  ADD CONSTRAINT "BankSettlementAccount_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
