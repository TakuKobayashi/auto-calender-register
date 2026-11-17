import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CALENDAR_SCOPE,
  readGoogleAuth,
  validateSavedAuth,
  validOAuthState,
  loginGoogle,
  readGoogleClient,
} from '../src/google-auth.js';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';

const saved = {
  version: 1 as const,
  client_id: 'test-client',
  client_secret: 'test-secret',
  refresh_token: 'test-refresh',
};

test('保存するOAuth情報はリフレッシュトークンを必須とし、アクセストークン等を含めない', () => {
  const result = validateSavedAuth({ ...saved, access_token: 'do-not-save', expiry_date: 123 });
  assert.deepEqual(result, saved);
  assert.throws(() => validateSavedAuth({ ...saved, refresh_token: '' }));
});

test('GitHub SecretのJSONと個別環境変数から認証情報を読み込める', async () => {
  assert.deepEqual(
    await readGoogleAuth('not-used', { GOOGLE_OAUTH_JSON: JSON.stringify(saved) }),
    saved,
  );
  assert.deepEqual(
    await readGoogleAuth('not-used', {
      GOOGLE_CLIENT_ID: saved.client_id,
      GOOGLE_CLIENT_SECRET: saved.client_secret,
      GOOGLE_REFRESH_TOKEN: saved.refresh_token,
    }),
    saved,
  );
  await assert.rejects(
    readGoogleAuth('not-used', { GOOGLE_OAUTH_JSON: 'sensitive-invalid-json' }),
    (error) => {
      assert.doesNotMatch(String(error), /sensitive-invalid-json/);
      return true;
    },
  );
});

test('初回認証は.envのID・シークレットだけで開始でき、トークンもJSONも不要', async () => {
  assert.deepEqual(
    await readGoogleClient(undefined, {
      GOOGLE_CLIENT_ID: ' test-client ',
      GOOGLE_CLIENT_SECRET: ' test-secret ',
    }),
    {
      client_id: 'test-client',
      client_secret: 'test-secret',
    },
  );
  await assert.rejects(
    readGoogleClient(undefined, { GOOGLE_CLIENT_ID: 'sensitive-test-client' }),
    (error) => {
      assert.match(String(error), /両方設定/);
      assert.doesNotMatch(String(error), /sensitive-test-client/);
      return true;
    },
  );
});

test('明示したクライアントJSONを優先し、初回認証後は.envの2項目と保存済みトークンを併用', async () => {
  const parent = resolve('reports');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'oauth-config-test-'));
  try {
    const clientFile = join(directory, 'client.json'),
      authFile = join(directory, 'auth.json');
    await writeFile(
      clientFile,
      JSON.stringify({
        installed: { client_id: saved.client_id, client_secret: saved.client_secret },
      }),
    );
    assert.deepEqual(
      await readGoogleClient(clientFile, {
        GOOGLE_CLIENT_ID: 'other-client',
        GOOGLE_CLIENT_SECRET: 'other-secret',
      }),
      {
        client_id: saved.client_id,
        client_secret: saved.client_secret,
      },
    );
    await writeFile(authFile, JSON.stringify(saved));
    assert.deepEqual(
      await readGoogleAuth(authFile, {
        GOOGLE_CLIENT_ID: saved.client_id,
        GOOGLE_CLIENT_SECRET: saved.client_secret,
        GOOGLE_REFRESH_TOKEN: '',
      }),
      saved,
    );
    await assert.rejects(
      readGoogleAuth(authFile, {
        GOOGLE_CLIENT_ID: 'different-client',
        GOOGLE_CLIENT_SECRET: saved.client_secret,
      }),
    );
    await writeFile(
      clientFile,
      JSON.stringify({ web: { client_id: saved.client_id, client_secret: saved.client_secret } }),
    );
    await assert.rejects(readGoogleClient(clientFile, {}), /デスクトップアプリ/);
  } finally {
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuthのstateが一致しないコールバックを拒否', () => {
  assert.equal(validOAuthState('expected', 'expected'), true);
  assert.equal(validOAuthState('different', 'expected'), false);
  assert.equal(validOAuthState(null, 'expected'), false);
});

test('Google OAuth URLはloopback・PKCE・offline access・同意画面を使用', async () => {
  const client = new OAuth2Client(
    'test-client',
    'test-secret',
    'http://127.0.0.1:12345/oauth2callback',
  );
  const verifier = await client.generateCodeVerifierAsync();
  const url = new URL(
    client.generateAuthUrl({
      scope: [CALENDAR_SCOPE],
      access_type: 'offline',
      prompt: 'consent',
      state: 'test-state',
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: verifier.codeChallenge,
    }),
  );
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:12345/oauth2callback');
  assert.equal(url.searchParams.get('scope'), CALENDAR_SCOPE);
  assert.notEqual(url.searchParams.get('code_challenge'), verifier.codeVerifier);
});

test('OAuthローカルcallbackのstate確認からトークン保存までをブラウザー・Google接続なしで検証', async () => {
  const parent = resolve('reports');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'oauth-test-'));
  const clientFile = join(directory, 'client.json'),
    authFile = join(directory, 'auth.json');
  await writeFile(
    clientFile,
    JSON.stringify({
      installed: { client_id: 'test.apps.googleusercontent.com', client_secret: 'test-secret' },
    }),
  );
  let callbackTask: Promise<void> | undefined;
  let invalidStateStatus = 0;
  let exchangedCode: unknown;
  const exchange = mock.method(OAuth2Client.prototype, 'getToken', async (options: any) => {
    exchangedCode = options;
    return {
      tokens: {
        refresh_token: 'test-refresh',
        access_token: 'must-not-persist',
        scope: CALENDAR_SCOPE,
      },
    };
  });
  const logging = mock.method(console, 'error', (message: string) => {
    const authUrl = message.match(/https:\/\/accounts\.google\.com\/\S+/)?.[0];
    if (!authUrl) return;
    callbackTask = (async () => {
      const url = new URL(authUrl);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', 'wrong-state');
      callback.searchParams.set('code', 'test-code');
      const invalid = await fetch(callback);
      invalidStateStatus = invalid.status;
      await invalid.text();
      callback.searchParams.set('state', url.searchParams.get('state')!);
      const valid = await fetch(callback);
      await valid.text();
    })();
  });
  try {
    assert.equal(await loginGoogle({ clientFile, authFile, browser: false }), authFile);
    await callbackTask;
    assert.equal(invalidStateStatus, 400);
    assert.equal((exchangedCode as any).code, 'test-code');
    assert.ok((exchangedCode as any).codeVerifier.length >= 43);
    const stored = JSON.parse(await readFile(authFile, 'utf8'));
    assert.equal(stored.refresh_token, 'test-refresh');
    assert.equal(stored.access_token, undefined);
  } finally {
    exchange.mock.restore();
    logging.mock.restore();
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
});
