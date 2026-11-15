import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedPortalRoute } from "./adminProductRoutePolicy.mjs";

function request(method, originalUrl) {
  return { method, originalUrl };
}

test("allows read-only product collection requests with supported filters", () => {
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/products")), true);
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/products?page=2&search=case&catalogId=abc")), true);
});

test("rejects product mutations and unsupported or repeated query parameters", () => {
  assert.equal(isAllowedPortalRoute(request("POST", "/api/store/admin-portal/products")), false);
  assert.equal(isAllowedPortalRoute(request("PATCH", "/api/store/admin-portal/products/123")), false);
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/products?limit=100")), false);
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/products?page=1&page=2")), false);
});

test("allows catalog reads only and rejects catalog writes or query parameters", () => {
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/catalogs")), true);
  assert.equal(isAllowedPortalRoute(request("POST", "/api/store/admin-portal/catalogs")), false);
  assert.equal(isAllowedPortalRoute(request("PATCH", "/api/store/admin-portal/catalogs/123")), false);
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/catalogs?page=1")), false);
});

test("allows approved portal GET routes with only their supported filters", () => {
  for (const path of [
    "/summary",
    "/orders?page=1&status=pending",
    "/users?page=1&q=alice",
    "/transactions?page=1&type=wallet&status=success",
    "/topups?page=1",
    "/analytics?period=30d",
    "/gateways",
  ]) {
    assert.equal(isAllowedPortalRoute(request("GET", `/api/store/admin-portal${path}`)), true, path);
  }
});

test("rejects portal writes, unknown routes, and unsupported query parameters", () => {
  assert.equal(isAllowedPortalRoute(request("POST", "/api/store/admin-portal/orders")), false);
  assert.equal(isAllowedPortalRoute(request("DELETE", "/api/store/admin-portal/users/123")), false);
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/summary?debug=true")), false);
  assert.equal(isAllowedPortalRoute(request("GET", "/api/store/admin-portal/analytics?period=30d&debug=true")), false);
  assert.equal(isAllowedPortalRoute(request("POST", "/api/store/admin-portal/media")), false);
});
