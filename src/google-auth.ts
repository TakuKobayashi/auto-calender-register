import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import open from 'open';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const DEFAULT_AUTH_FILE = '.secrets/google-oauth.json';
export type SavedGoogleAuth = {
  version: 1;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  scope?: string;
};

export function validateSavedAuth(value: unknown): SavedGoogleAuth {
  if (!value || typeof value !== 'object')
    throw new Error('Google OAuth情報のJSON形式が不正です。');
  const data = value as SavedGoogleAuth;
  if (
    data.version !== 1 ||
    ['client_id', 'client_secret', 'refresh_token'].some(
      (key) =>
        typeof data[key as keyof SavedGoogleAuth] !== 'string' ||
        !String(data[key as keyof SavedGoogleAuth]).trim(),
    )
  ) {
    throw new Error(
      'Google OAuth情報にはversion:1、client_id、client_secret、refresh_tokenが必要です。',
    );
  }
  return {
    version: 1,
    client_id: data.client_id,
    client_secret: data.client_secret,
    refresh_token: data.refresh_token,
    ...(typeof data.scope === 'string' ? { scope: data.scope } : {}),
  };
}

export async function readGoogleAuth(file = DEFAULT_AUTH_FILE, env = process.env) {
  try {
    if (env.GOOGLE_OAUTH_JSON) return validateSavedAuth(JSON.parse(env.GOOGLE_OAUTH_JSON));
    if (env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET || env.GOOGLE_REFRESH_TOKEN) {
      return validateSavedAuth({
        version: 1,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
      });
    }
    return validateSavedAuth(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    throw new Error(
      'Google OAuth情報を読み込めません。auth loginを実行するかGOOGLE_OAUTH_JSONを設定してください。',
    );
  }
}

export async function createGoogleAuth(file = DEFAULT_AUTH_FILE) {
  const saved = await readGoogleAuth(file);
  const auth = new OAuth2Client(saved.client_id, saved.client_secret);
  auth.setCredentials({ refresh_token: saved.refresh_token });
  return auth;
}

export async function writeGoogleAuth(file: string, saved: SavedGoogleAuth) {
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(validateSavedAuth(saved), null, 2) + '\n', {
    mode: 0o600,
  });
  return target;
}

export function validOAuthState(received: string | null, expected: string) {
  if (!received) return false;
  const a = Buffer.from(received),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function loginGoogle(options: {
  clientFile: string;
  authFile: string;
  browser: boolean;
}) {
  let installed: { client_id: string; client_secret: string };
  try {
    const raw = JSON.parse(await readFile(options.clientFile, 'utf8'));
    if (!raw.installed?.client_id || !raw.installed?.client_secret) throw new Error();
    installed = raw.installed;
  } catch {
    throw new Error(
      'デスクトップアプリ用OAuthクライアントJSONを --client-file で指定してください。',
    );
  }
  const state = randomBytes(32).toString('hex');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('OAuth待受ポートを取得できません。');
  }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const auth = new OAuth2Client(installed.client_id, installed.client_secret, redirectUri);
  const verifier = await auth.generateCodeVerifierAsync();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [CALENDAR_SCOPE],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: verifier.codeChallenge,
  });
  let timer: NodeJS.Timeout | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error('OAuth認証が5分でタイムアウトしました。auth loginを再実行してください。')),
      5 * 60_000,
    );
    server.on('error', () => reject(new Error('OAuth待受サーバーでエラーが発生しました。')));
    server.on('request', (request, response) => {
      const callback = new URL(request.url ?? '/', redirectUri);
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET' || callback.pathname !== '/oauth2callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (!validOAuthState(callback.searchParams.get('state'), state)) {
        response.writeHead(400).end('Invalid OAuth state');
        return;
      }
      if (callback.searchParams.has('error')) {
        response.writeHead(400).end('認証が許可されませんでした。ターミナルを確認してください。');
        reject(new Error('Google OAuthが拒否されました。'));
        return;
      }
      const code = callback.searchParams.get('code');
      if (!code) {
        response.writeHead(400).end('Missing authorization code');
        return;
      }
      response.end(
        '認証コードを受信しました。ターミナルで保存完了を確認し、このページを閉じてください。',
      );
      resolve(code);
    });
  });
  // ブラウザーを開いている間に拒否されても未処理Promiseにしない。
  void codePromise.catch(() => {});
  try {
    console.error(`ブラウザーでGoogle認証を行ってください:\n${url}`);
    if (options.browser) {
      try {
        await open(url);
      } catch {
        console.error('ブラウザーを起動できませんでした。上記URLを手動で開いてください。');
      }
    }
    const code = await codePromise;
    let tokens;
    try {
      ({ tokens } = await auth.getToken({
        code,
        codeVerifier: verifier.codeVerifier,
        redirect_uri: redirectUri,
      }));
    } catch {
      throw new Error(
        'Google認証コードの交換に失敗しました。OAuth設定とCalendar APIの有効化を確認してください。',
      );
    }
    if (!tokens.refresh_token)
      throw new Error(
        'refresh_tokenを取得できませんでした。Google側のアプリ許可を確認して再認証してください。',
      );
    return await writeGoogleAuth(options.authFile, {
      version: 1,
      client_id: installed.client_id,
      client_secret: installed.client_secret,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    });
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
