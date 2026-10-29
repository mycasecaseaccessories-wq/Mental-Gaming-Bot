const apiHandler = require("../../[...path].js");

module.exports = function adminMediaHandler(req, res) {
  const originalUrl = typeof req.url === "string" ? req.url : "/";
  if (!originalUrl.startsWith("/api/")) {
    req.url = "/api/store/admin-portal/media";
  }
  return apiHandler(req, res);
};
