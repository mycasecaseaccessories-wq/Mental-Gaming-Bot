const apiHandler = require("../../[...path].js");

module.exports = function catalogsHandler(req, res) {
  const originalUrl = typeof req.url === "string" ? req.url : "/";
  if (!originalUrl.startsWith("/api/")) {
    const query = originalUrl.includes("?") ? originalUrl.slice(originalUrl.indexOf("?")) : "";
    req.url = `/api/store/admin-portal/catalogs${query}`;
  }
  return apiHandler(req, res);
};
