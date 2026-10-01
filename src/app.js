const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { errorHandler, ApiError } = require('./utils/http');
const { authenticate } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const { users, teams, sources, statuses, stages, tags, meta, hierarchy } = require('./routes/admin');
const leadsRoutes = require('./routes/leads');
const { customers, contacts } = require('./routes/customers');
const activitiesRoutes = require('./routes/activities');
const followupsRoutes = require('./routes/followups');
const tasksRoutes = require('./routes/tasks');
const opportunitiesRoutes = require('./routes/opportunities');
const productsRoutes = require('./routes/products');
const quotesRoutes = require('./routes/quotes');
const invoicesRoutes = require('./routes/invoices');
const paymentsRoutes = require('./routes/payments');
const reportsRoutes = require('./routes/reports');
const auditRoutes = require('./routes/audit');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);

app.use('/api', authenticate);
app.use('/api/meta', meta);
app.use('/api/hierarchy', hierarchy);
app.use('/api/users', users);
app.use('/api/teams', teams);
app.use('/api/lead-sources', sources);
app.use('/api/lead-statuses', statuses);
app.use('/api/lead-stages', stages);
app.use('/api/tags', tags);
app.use('/api/leads', leadsRoutes);
app.use('/api/customers', customers);
app.use('/api/contacts', contacts);
app.use('/api/activities', activitiesRoutes);
app.use('/api/follow-ups', followupsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/opportunities', opportunitiesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/quotes', quotesRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/audit-logs', auditRoutes);

app.use((req, res, next) => next(new ApiError(404, 'Endpoint not found')));
app.use(errorHandler);
module.exports = app;
