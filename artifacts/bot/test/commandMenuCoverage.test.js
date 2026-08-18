const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const botRoot = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(botRoot, 'src/index.js'), 'utf8');
const commandsDir = path.join(botRoot, 'src/commands');

function extractMenuCommands() {
  const start = indexSource.indexOf('const menu = [');
  const end = indexSource.indexOf('].filter(({ command })', start);
  assert.ok(start >= 0 && end > start, 'dynamic command menu declaration must remain discoverable');
  return [...indexSource.slice(start, end).matchAll(/command:\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );
}

function extractSourceCommands() {
  const source = fs
    .readdirSync(commandsDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(commandsDir, file), 'utf8'))
    .join('\n');
  const commands = new Set([...source.matchAll(/bot\.command\(\s*['"]([^'"]+)/g)].map((m) => m[1]));
  if (/bot\.start\s*\(/.test(source)) commands.add('start');
  if (/bot\.help\s*\(/.test(source)) commands.add('help');
  // /setmenu is registered in bootstrap rather than a command module.
  commands.add('setmenu');
  return commands;
}

test('every Telegram menu entry has a source handler', () => {
  const menu = extractMenuCommands();
  const handlers = extractSourceCommands();
  const missing = menu.filter((command) => !handlers.has(command));
  assert.deepEqual(missing, [], `menu entries without handlers: ${missing.join(', ')}`);
  assert.equal(new Set(menu).size, menu.length, 'command menu must not contain duplicates');
});
