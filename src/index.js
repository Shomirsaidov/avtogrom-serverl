import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import servicesRouter from './routes/services.js';
import specialistsRouter from './routes/specialists.js';
import bookingsRouter from './routes/bookings.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/services', servicesRouter);
app.use('/api/specialists', specialistsRouter);
app.use('/api/bookings', bookingsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`avtogrom server listening on http://localhost:${port}`);
});
