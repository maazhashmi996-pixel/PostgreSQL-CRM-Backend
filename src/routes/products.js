const { crud } = require('../utils/crud');
const { ROLES } = require('../middleware/auth');
const { z, str, reqStr, money, bool } = require('../utils/schemas');

const schema = z.object({ name: reqStr(150, 'Name'), sku: reqStr(40, 'SKU'), description: str(1000), category: str(60), price: money('Price'), is_active: bool().optional() });

module.exports = crud({
  table: 'products', alias: 'p', from: 'products p', columns: 'p.id, p.name, p.sku, p.description, p.category, p.price, p.is_active, p.created_at',
  create: schema, searchCols: ['p.name', 'p.sku', 'p.category'], filters: { category: 'p.category', is_active: 'p.is_active' },
  sortable: { name: 'p.name', price: 'p.price', created_at: 'p.created_at' }, defaultSort: 'p.name ASC',
  writeRoles: ROLES.manage, deleteRoles: ROLES.manage,
});
