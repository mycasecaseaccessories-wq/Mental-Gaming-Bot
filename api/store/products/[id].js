const apiHandler = require("../../[...path].js");

module.exports = function productByIdHandler(req, res) {
  const originalUrl = typeof req.url === "string" ? req.url : "/";
  if (!originalUrl.startsWith("/api/")) {
    const [pathname, query = ""] = originalUrl.split("?", 2);
    const pathId = pathname === "/" && typeof req.query?.id === "string"
      ? `/${encodeURIComponent(req.query.id)}`
      : pathname;
    req.url = `/api/store/products${pathId === "/" ? "" : pathId}${query ? `?${query}` : ""}`;
  }
  return apiHandler(req, res);
};
