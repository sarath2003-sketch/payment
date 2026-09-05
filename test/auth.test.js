const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { authenticateToken, requireAdmin, memberOnly } = require('../server/middleware/auth');

const secret = 'your-secret-key-change-this-in-production';

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function requestWithToken(payload) {
  return {
    headers: {
      authorization: `Bearer ${jwt.sign(payload, secret)}`
    }
  };
}

test('authentication rejects missing tokens with 401', () => {
  const response = responseDouble();
  let called = false;

  authenticateToken({ headers: {} }, response, () => { called = true; });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'Access token required');
  assert.equal(called, false);
});

test('admin authorization rejects member tokens with 403', () => {
  const response = responseDouble();
  let called = false;

  requireAdmin(requestWithToken({ id: 7, type: 'member' }), response, () => { called = true; });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, 'Admin access required');
  assert.equal(called, false);
});

test('admin authorization accepts admin tokens', () => {
  const response = responseDouble();
  let called = false;
  const req = requestWithToken({ id: 1, username: 'admin', type: 'admin' });

  requireAdmin(req, response, () => { called = true; });

  assert.equal(response.statusCode, 200);
  assert.equal(called, true);
  assert.equal(req.admin.type, 'admin');
});

test('member authorization accepts member tokens', () => {
  const response = responseDouble();
  let called = false;
  const req = requestWithToken({ id: 7, member_id: '101', type: 'member' });

  memberOnly(req, response, () => { called = true; });

  assert.equal(response.statusCode, 200);
  assert.equal(called, true);
  assert.equal(req.admin.member_id, '101');
});
