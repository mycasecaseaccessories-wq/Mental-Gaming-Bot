/**
 * Read-only route allowlist for the Phase 1 Admin Preview API.
 * Kept in plain ESM so Node's built-in test runner can import it directly.
 */
export function isAllowedPortalRoute(req) {
  let url;
  try {
    url = new URL(req.originalUrl, "http://localhost");
  } catch {
    return false;
  }

  const path = url.pathname;
  const method = req.method.toUpperCase();
  const base = "/api/store/admin-portal";

  if (path === `${base}/products`) {
    if (method !== "GET") return false;
    const allowedQuery = new Set(["page", "search", "catalogId"]);
    const keys = [...url.searchParams.keys()];
    return keys.every((key, index) => allowedQuery.has(key) && keys.indexOf(key) === index);
  }
  if (path === `${base}/catalogs`) return method === "GET" && url.search === "";

  const readOnlyMatch = path.match(/^\/api\/store\/admin-portal\/(summary|orders|users|transactions|topups|analytics|gateways)$/);
  if (readOnlyMatch && method === "GET") {
    const route = readOnlyMatch[1];
    const allowed = route === "summary" || route === "gateways" ? new Set()
      : route === "analytics" ? new Set(["period"])
      : route === "orders" ? new Set(["page", "status"])
      : route === "users" ? new Set(["page", "q"])
      : route === "transactions" ? new Set(["page", "type", "status"])
      : new Set(["page"]);
    const keys = [...url.searchParams.keys()];
    return keys.every((key, index) => allowed.has(key) && keys.indexOf(key) === index);
  }
  return false;
}
