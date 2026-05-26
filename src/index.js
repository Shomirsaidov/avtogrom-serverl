import 'dotenv/config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const __dirname = dirname(fileURLToPath(import.meta.url));

import authRouter from './routes/auth.js';
import servicesRouter from './routes/services.js';
import specialistsRouter from './routes/specialists.js';
import bookingsRouter from './routes/bookings.js';
import conversationsRouter from './routes/conversations.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static(join(__dirname, '../public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/services', servicesRouter);
app.use('/api/specialists', specialistsRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/conversations', conversationsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`avtogrom server listening on http://localhost:${port}`);
});
