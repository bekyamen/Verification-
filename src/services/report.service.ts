import { Response } from 'express';
import exceljs from 'exceljs';
import prisma from '../utils/prisma';

export const generateDailyExcelReport = async (branchId: string, startDate: Date, endDate: Date, res: Response) => {
  const records = await prisma.verificationRecord.findMany({
    where: {
      branchId,
      verifiedAt: {
        gte: startDate,
        lte: endDate
      }
    },
    orderBy: { verifiedAt: 'desc' },
    include: {
      branch: true 
    }
  });

  const workbook = new exceljs.Workbook();
  workbook.creator = 'CheckFlow ET Backend';
  
  const sheet = workbook.addWorksheet('Reconciliation Ledger');

  sheet.columns = [
    { header: 'Time Verified', key: 'time', width: 22 },
    { header: 'Cashier ID', key: 'cashier', width: 35 }, // We would ideally join User table here too
    { header: 'Bank Provider', key: 'provider', width: 15 },
    { header: 'Transaction Ref', key: 'txnRef', width: 25 },
    { header: 'Amount (ETB)', key: 'amount', width: 15 },
    { header: 'Status', key: 'status', width: 20 },
  ];

  // Header styling
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF004E8A' } };

  let totalTelebirr = 0;
  let totalCBE = 0;
  let blockedFraud = 0;

  records.forEach(rc => {
    const val = parseFloat(rc.amount.toString());
    
    if (rc.status === 'VERIFIED') {
       if (rc.provider === 'TELEBIRR') totalTelebirr += val;
       if (rc.provider.startsWith('CBE')) totalCBE += val;
    } else if (rc.status === 'FLAGGED_DUPLICATE') {
       blockedFraud++;
    }

    sheet.addRow({
      time: rc.verifiedAt ? rc.verifiedAt.toLocaleString() : '-',
      cashier: rc.cashierId,
      provider: rc.provider,
      txnRef: rc.txnReference,
      amount: val,
      status: rc.status,
    });
  });

  sheet.addRow([]);
  sheet.addRow(['Summary Metrics']);
  sheet.getRow(sheet.rowCount).font = { bold: true };
  
  sheet.addRow(['Total Telebirr Verified', '', '', '', totalTelebirr]);
  sheet.addRow(['Total CBE Verified', '', '', '', totalCBE]);
  sheet.addRow(['Net Verified Revenue', '', '', '', totalTelebirr + totalCBE]);
  sheet.addRow(['Blocked Frauds (Duplicates)', '', '', '', blockedFraud]);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=CheckFlow_Ledger_${new Date().toISOString().split('T')[0]}.xlsx`
  );

  await workbook.xlsx.write(res);
  res.end();
};
