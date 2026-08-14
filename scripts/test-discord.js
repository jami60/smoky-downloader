// Smoky — Discord-Tests:
//  - discord-rpc.js: Frame-Encoding/-Decoding, hasValidId, setClientId.
//  - server.js: /api/discord/* Endpunkte (Status, Authorize-Validierung,
//    Disconnect, Callback-Fehlschlag ohne gültigen State).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.SMOKY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-discord-data-'));
const { buildFrame, parseFrames, OP_HANDSHAKE, OP_FRAME, OP_PING, DiscordRPC } = require('../electron/discord-rpc.js');
const { startServer, settings, server } = require('../server.js');

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')); if (!ok) failed += 1; };

(async () => {
  // ------------------------------------------------ discord-rpc (pure) -----
  const roundtrip = (op, payload) => parseFrames(buildFrame(op, payload)).frames[0];
  const f0 = roundtrip(OP_HANDSHAKE, { v: 1, client_id: '123' });
  check('buildFrame/parseFrames: Handshake-Roundtrip', f0.op === OP_HANDSHAKE && f0.payload.client_id === '123', JSON.stringify(f0));
  const f1 = roundtrip(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: 1, activity: { details: '🎵 x' } }, nonce: 'n' });
  check('buildFrame/parseFrames: SET_ACTIVITY-Roundtrip', f1.op === OP_FRAME && f1.payload.cmd === 'SET_ACTIVITY' && f1.payload.args.activity.details === '🎵 x', JSON.stringify(f1));

  // Teil-Puffer: parseFrames darf bei unvollständigem Frame nichts verlieren.
  const full = buildFrame(OP_PING, { nonce: 'p' });
  const half = parseFrames(full.subarray(0, 5));
  check('parseFrames: halber Frame → 0 Frames + Rest bleibt', half.frames.length === 0 && half.rest.length === 5, 'rest=' + half.rest.length);
  const rest = parseFrames(Buffer.concat([full.subarray(0, 5), full.subarray(5)]));
  check('parseFrames: Rest + Fortsetzung → kompletter Frame', rest.frames.length === 1 && rest.frames[0].op === OP_PING, JSON.stringify(rest.frames));

  check('hasValidId: nur Ziffern', DiscordRPC.hasValidId('123456789') === true && DiscordRPC.hasValidId('DEINE_ID') === false && DiscordRPC.hasValidId('') === false, '');

  const rpc = new DiscordRPC('');
  check('setClientId: leer → keine Verbindung (isConnected=false)', (() => { rpc.setClientId(''); return rpc.clientId === '' && !rpc.isConnected(); })(), rpc.clientId);
  rpc.setClientId('123456789');
  check('setClientId: gültige ID übernommen', rpc.clientId === '123456789', rpc.clientId);
  rpc.disconnect(); // Timer aufräumen, damit der Prozess endet

  // ------------------------------------------------ server /api/discord -----
  settings.discordClientId = '';
  settings.discordClientSecret = '';
  settings.discordRpc = true;
  settings.discordProfile = null;
  settings.discordToken = null;
  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;
  const get = async (p, opts) => fetch(base + p, opts);

  const st0 = await (await get('/api/discord/status')).json();
  check('/api/discord/status: Defaults (nicht verbunden, RPC an)', st0.connected === false && st0.rpcEnabled === true && st0.rpcConfigured === false && !!st0.redirectUri, JSON.stringify(st0));
  check('/api/discord/status: redirectUri zeigt auf lokalen Callback', /^http:\/\/127\.0\.0\.1:\d+\/api\/discord\/callback$/.test(st0.redirectUri), st0.redirectUri);

  const auth1 = await get('/api/discord/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('/api/discord/authorize ohne ID/Secret → 400', auth1.status === 400, String(auth1.status));

  settings.discordClientId = '123456789';
  settings.discordClientSecret = 'secret';
  const auth2 = await get('/api/discord/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const auth2j = await auth2.json();
  check('/api/discord/authorize mit ID+Secret → 200 + URL', auth2.status === 200 && /^https:\/\/discord\.com\/oauth2\/authorize\?/.test(auth2j.url) && auth2j.url.includes('client_id=123456789') && auth2j.url.includes('scope=identify'), auth2j.url);
  check('/api/discord/authorize: URL enthält state', auth2j.url.includes('state='), auth2j.url);

  const cb = await get('/api/discord/callback?code=x&state=falsch');
  const cbText = await cb.text();
  check('/api/discord/callback mit falschem State → HTML-Fehler (kein 500)', cb.status === 200 && /fehlgeschlagen/i.test(cbText), 'status=' + cb.status);

  const dis = await get('/api/discord/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('/api/discord/disconnect → 200', dis.status === 200, String(dis.status));

  // Secret/Token dürfen NIE über /api/status nach außen.
  settings.discordClientSecret = 'geheim';
  settings.discordToken = 'token-geheim';
  const status = await (await get('/api/status')).json();
  check('/api/status: Secret + Token nicht geleakt', !('discordClientSecret' in status.settings) && !('discordToken' in status.settings), JSON.stringify(status.settings));

  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Discord-Tests bestanden ✅');
  try { server.closeAllConnections(); } catch {}
  await new Promise((r) => server.close(r));
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('Discord-Test abgestürzt:', e); process.exitCode = 1; });
