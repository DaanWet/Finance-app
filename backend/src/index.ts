import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import transactionsRouter from './routes/transactions';
import reimbursementsRouter from './routes/reimbursements';
import organizationsRouter from './routes/organizations';
import categoriesRouter from './routes/categories';
import settingsRouter from './routes/settings';
import dashboardRouter from './routes/dashboard';
import splitwiseRouter from './routes/splitwise';
import importRouter from './routes/import';
import classificationRulesRouter from './routes/classificationRules';

const app = express();
const PORT = process.env['PORT'] ?? 3000;

app.use(cors({ origin: 'http://localhost:4222' }));
app.use(express.json());

app.use('/api/transactions', transactionsRouter);
app.use('/api/reimbursements', reimbursementsRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/splitwise', splitwiseRouter);
app.use('/api/import', importRouter);
app.use('/api/classification-rules', classificationRulesRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Finance API running on http://localhost:${PORT}`);
});
