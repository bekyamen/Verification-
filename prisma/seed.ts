import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Wipe existing
  await prisma.verificationRecord.deleteMany({});
  await prisma.dailyReport.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.branch.deleteMany({});
  await prisma.organization.deleteMany({});
  
  // Seed Organization
  const org = await prisma.organization.create({
    data: {
      name: 'Bole Boutique Cafe',
      phone: '+251911000000',
      city: 'Addis Ababa'
    }
  });

  // Seed Branch
  const branch = await prisma.branch.create({
    data: {
      name: 'Main Branch - Bole',
      organizationId: org.id
    }
  });

  // Seed Admin User
  const adminPass = await bcrypt.hash('admin123', 10);
  await prisma.user.create({
    data: {
      fullName: 'Beti Manager',
      phone: '+251911123456',
      passwordHash: adminPass,
      role: 'MANAGER',
      organizationId: org.id,
      branchId: branch.id
    }
  });

  // Seed Cashiers
  const cashierPass1 = await bcrypt.hash('cashier123', 10);
  const pin1 = await bcrypt.hash('1234', 10);
  const cashier1 = await prisma.user.create({
    data: {
      fullName: 'Alem (Counter 1)',
      phone: '+251922000001',
      passwordHash: cashierPass1,
      pinCode: pin1,
      role: 'CASHIER',
      organizationId: org.id,
      branchId: branch.id
    }
  });

  const pin2 = await bcrypt.hash('5678', 10);
  await prisma.user.create({
    data: {
      fullName: 'Dawit (Counter 2)',
      phone: '+251922000002',
      passwordHash: cashierPass1,
      pinCode: pin2,
      role: 'CASHIER',
      organizationId: org.id,
      branchId: branch.id
    }
  });

  console.log('✅ CheckFlow ET Seed executed successfully!');
  console.log(`Org ID: ${org.id}`);
  console.log(`Branch ID: ${branch.id}`);
  console.log(`Cashier1 ID: ${cashier1.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
