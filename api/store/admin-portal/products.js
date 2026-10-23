const apiHandler = require("../../[...path].js");

module.exports = function productsHandler(req, res) {
  const originalUrl = typeof req.url === "string" ? req.url : "/";
  if (!originalUrl.startsWith("/api/")) {
    const [pathname, query = ""] = originalUrl.split("?", 2);
    req.url = `/api/store/admin-portal/products${pathname === "/" ? "" : pathname}${query ? `?${query}` : ""}`;
  }
  return apiHandler(req, res);
};
