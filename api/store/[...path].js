// Vercel can resolve a nested catch-all more reliably than a root-level
// catch-all when the API project is configured with a custom root directory.
// Reuse the single bundled Express handler so all routes share middleware.
module.exports = require('../[...path].js');
