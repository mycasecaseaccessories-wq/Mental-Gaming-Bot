const test = require('node:test');
const assert = require('node:assert/strict');

function mockModule(relPath, exports) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

let activeAdmins = new Map();

mockModule('../src/models/Admin', {
  ROLES: ['OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'SUPPORT'],
  ROLE_LEVEL: { OWNER: 3, ADMIN: 2, MANAGER: 2, STAFF: 1, SUPPORT: 1 },
  findOne: async ({ telegramId }) => activeAdmins.get(Number(telegramId)) || null,
});
mockModule('../src/services/logger', { auditLog: async () => {} });
mockModule('../config/settings', { config: { bot: { adminId: 9001 } } });

const AdminService = require('../src/services/AdminService');

function setAdmin(telegramId, role) {
  activeAdmins.set(Number(telegramId), { telegramId: Number(telegramId), role, isActive: true });
}

test('role permission matrix exposes least-privilege boundaries', () => {
  assert.deepEqual(AdminService.getPermissionsForRole('STAFF'), ['orders', 'support', 'guide']);
  assert.ok(AdminService.getPermissionsForRole('MANAGER').includes('finance'));
  assert.ok(!AdminService.getPermissionsForRole('MANAGER').includes('admin_roles'));
  assert.ok(AdminService.getPermissionsForRole('OWNER').includes('admin_roles'));
  assert.deepEqual(AdminService.getPermissionsForRole('UNKNOWN'), []);
});

test('role hierarchy allows higher roles and rejects lower roles', async () => {
  setAdmin(1001, 'STAFF');
  setAdmin(1002, 'MANAGER');
  setAdmin(1003, 'OWNER');

  assert.equal(await AdminService.hasRole(1001, 'STAFF'), true);
  assert.equal(await AdminService.hasRole(1001, 'MANAGER'), false);
  assert.equal(await AdminService.hasRole(1002, 'STAFF'), true);
  assert.equal(await AdminService.hasRole(1002, 'OWNER'), false);
  assert.equal(await AdminService.hasRole(1003, 'OWNER'), true);
  assert.equal(await AdminService.hasRole(9999, 'STAFF'), false);
});

test('explicit permissions match the role matrix', async () => {
  setAdmin(2001, 'STAFF');
  setAdmin(2002, 'MANAGER');
  setAdmin(2003, 'OWNER');

  assert.equal(await AdminService.hasPermission(2001, 'orders'), true);
  assert.equal(await AdminService.hasPermission(2001, 'finance'), false);
  assert.equal(await AdminService.hasPermission(2002, 'finance'), true);
  assert.equal(await AdminService.hasPermission(2002, 'admin_roles'), false);
  assert.equal(await AdminService.hasPermission(2003, 'admin_roles'), true);
});

test('configured environment owner is always OWNER', async () => {
  assert.equal(AdminService.isEnvOwner(9001), true);
  assert.equal(await AdminService.getAdminRole(9001), 'OWNER');
  assert.equal(await AdminService.hasPermission(9001, 'admin_roles'), true);
});
