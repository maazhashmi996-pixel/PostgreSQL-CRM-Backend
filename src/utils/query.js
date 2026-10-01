/** Positional-parameter builder: q.add(value) -> '$n' */
class Q {
  constructor() { this.params = []; }
  add(v) { this.params.push(v); return `$${this.params.length}`; }
}

function pageParams(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

module.exports = { Q, pageParams, escapeLike };
