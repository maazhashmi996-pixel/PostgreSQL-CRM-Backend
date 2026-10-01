const { ZodError } = require('zod');

class ApiError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Friendly messages for named constraints (never expose raw DB errors to the client)
const UNIQUE_MESSAGES = {
  uq_users_email: ['email', 'This email address is already registered'],
  uq_customers_email: ['email', 'A customer with this email already exists'],
  uq_contacts_customer_email: ['email', 'This contact email already exists for the customer'],
  uq_contacts_one_primary: ['is_primary', 'This customer already has a primary contact'],
  uq_payments_invoice_reference: ['reference', 'This payment reference is already used for the invoice'],
  products_sku_key: ['sku', 'SKU already exists'],
  teams_name_key: ['name', 'A team with this name already exists'],
  tags_name_key: ['name', 'A tag with this name already exists'],
  lead_sources_name_key: ['name', 'A source with this name already exists'],
  lead_statuses_name_key: ['name', 'A status with this name already exists'],
  lead_stages_name_key: ['name', 'A stage with this name already exists'],
};

function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) return res.status(err.status).json({ message: err.message, errors: err.errors });

  if (err instanceof ZodError) {
    const errors = {};
    for (const i of err.issues) errors[i.path.join('.') || '_'] = errors[i.path.join('.') || '_'] || i.message;
    return res.status(422).json({ message: 'Please correct the highlighted fields', errors });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Malformed JSON body' });

  switch (err.code) {
    case '23505': {
      const [field, msg] = UNIQUE_MESSAGES[err.constraint] || ['_', 'A record with the same value already exists'];
      return res.status(409).json({ message: msg, errors: { [field]: msg } });
    }
    case '23503':
      return res.status(409).json({ message: 'This record is linked to other data (or the referenced record does not exist)' });
    case '23514':
      return res.status(422).json({ message: 'One of the values breaks a business rule (check amounts, dates and statuses)' });
    case '23502':
      return res.status(422).json({ message: `${err.column || 'A required field'} is required`, errors: { [err.column || '_']: 'Required' } });
    case '22P02': case '22007': case '22003': case '22008':
      return res.status(400).json({ message: 'Invalid value supplied' });
    case 'CR001':                       // business rule raised by our own PostgreSQL functions/triggers
      return res.status(409).json({ message: err.message });
    default:
  }
  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ message: 'Something went wrong on the server' });
}

module.exports = { ApiError, asyncHandler, errorHandler };
