const { z } = require('zod');

const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

const str = (max = 255) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const reqStr = (max = 255, label = 'This field') =>
  z.string({ required_error: `${label} is required`, invalid_type_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);
const email = () => z.preprocess(emptyToNull, z.string().trim().toLowerCase().email('Enter a valid email address').max(255).nullable().optional());
const reqEmail = () => z.string({ required_error: 'Email is required' }).trim().toLowerCase().email('Enter a valid email address').max(255);
const id = (label = 'This field') => z.coerce.number({ invalid_type_error: `${label} is required`, required_error: `${label} is required` }).int().positive(`${label} is required`);
const optId = () => z.preprocess(emptyToNull, z.coerce.number().int().positive().nullable().optional());
const money = (label = 'Amount') => z.coerce.number({ invalid_type_error: `${label} must be a number` }).min(0, `${label} cannot be negative`).max(999999999999);
const date = () => z.preprocess(emptyToNull, z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date').nullable().optional());
const reqDate = (label = 'Date') => z.string({ required_error: `${label} is required` }).refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');
const bool = () => z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const oneOf = (values, def) => (def === undefined ? z.enum(values) : z.enum(values).default(def));

const passwordRule = z.string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

module.exports = { z, str, reqStr, email, reqEmail, id, optId, money, date, reqDate, bool, oneOf, passwordRule };
