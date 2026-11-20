import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(path.join(tmpdir(), 'edgeledger-auth-'));
const port = 25000 + Math.floor(Math.random() * 10000);
const base = 'http://127.0.0.1:' + port;
let child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(), env: { ...process.env, JOURNAL_DB: path.join(dir, 'test.db'), PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', b => { stderr += b.toString(); });
async function wait() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('Server exited: ' + stderr);
    try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not start: ' + stderr);
}
async function call(route, { method = 'GET', body, cookie, raw, contentType } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (raw !== undefined) headers['content-type'] = contentType || 'image/png';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + '/api' + route, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
test('signup, login, logout, user isolation, old trades remain unassigned', async () => {
  try {
    await wait();
    const unauth = await call('/trades');
    assert.equal(unauth.status, 401);
    const a = await call('/auth/signup', { method: 'POST', body: { email: 'a@example.com', password: 'long-password-123' } });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.ok(a.cookie);
    const b = await call('/auth/signup', { method: 'POST', body: { email: 'b@example.com', password: 'long-password-456' } });
    assert.equal(b.status, 200, JSON.stringify(b.data));
    const duplicate = await call('/auth/signup', { method: 'POST', body: { email: 'A@example.com', password: 'long-password-123' } });
    assert.equal(duplicate.status, 409);
    const loginBad = await call('/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'wrong-password' } });
    assert.equal(loginBad.status, 401);
    const loginGood = await call('/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'long-password-123' } });
    assert.equal(loginGood.status, 200);
    const created = await call('/trades', { method: 'POST', cookie: a.cookie, body: {
      symbol: 'NAS100', side: 'long', entry_price: 20000, size: 1, entry_at: '2026-11-20T10:00:00Z'
    } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.trade.id;
    assert.equal((await call('/trades', { cookie: a.cookie })).data.trades.length, 1);
    assert.equal((await call('/trades', { cookie: b.cookie })).data.trades.length, 0);
    const upload = await call('/trades/' + id + '/images?name=test.png', { method: 'POST', cookie: a.cookie, raw: Buffer.from([137,80,78,71]), contentType: 'image/png' });
    assert.equal(upload.status, 201, JSON.stringify(upload.data));
    const imageId = upload.data.image.id;
    assert.equal((await call('/images/' + imageId, { cookie: b.cookie })).status, 404);
    assert.equal((await call('/images/' + imageId, { method: 'DELETE', cookie: b.cookie })).status, 404);
    assert.equal((await call('/images/' + imageId, { cookie: a.cookie })).status, 200);
    assert.equal((await call('/auth/me', { cookie: a.cookie })).status, 200);

    assert.equal((await call('/trades/' + id, { cookie: b.cookie })).status, 404);
    assert.equal((await call('/trades/' + id, { method: 'DELETE', cookie: b.cookie })).status, 404);
    assert.equal((await call('/trades/' + id, { method: 'PATCH', cookie: b.cookie, body: { notes: 'stolen' } })).status, 404);
    assert.equal((await call('/trades/' + id + '/images', { method: 'POST', cookie: b.cookie })).status, 404);
    assert.equal((await call('/trades', { method: 'DELETE', cookie: b.cookie })).status, 200);
    assert.equal((await call('/trades', { cookie: a.cookie })).data.trades.length, 1);
    assert.equal((await call('/auth/logout', { method: 'POST', cookie: a.cookie })).status, 200);
    assert.equal((await call('/trades', { cookie: a.cookie })).status, 401);
    // A valid session must survive a server restart with the same SQLite database.
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(), env: { ...process.env, JOURNAL_DB: path.join(dir, 'test.db'), PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', b => { stderr += b.toString(); });
    await wait();
    assert.equal((await call('/auth/me', { cookie: b.cookie })).status, 200);
    assert.equal((await call('/trades', { cookie: b.cookie })).status, 200);
    assert.equal((await call('/trades', { cookie: a.cookie })).status, 401);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
