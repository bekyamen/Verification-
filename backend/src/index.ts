import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import apiRoutes from './routes/api.routes';
import authRoutes from './routes/auth.routes';
import { warmOcrWorkers, warmOcr } from './services/receiptParser.service';
import { warmPdf } from './services/verifyCBE';

dotenv.config();


const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Mount API routes
app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);

// Unhandled error management
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

app.listen(port, () => {
  console.log(`CheckFlow ET Backend Engine running on port ${port}`);
  // Pre-warm Tesseract workers in background so first image request doesn't wait
  warmOcrWorkers();
  warmOcr();
  warmPdf();
});


