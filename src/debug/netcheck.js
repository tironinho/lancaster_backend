    // src/debug/netcheck.js
import net from 'net';
import { URL as NodeURL } from 'url';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

export async function tcpDialOnce({ host, port, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();

    let done = false;
    function finish(ok, info) {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ ok, ms: Date.now() - started, ...info });
    }

    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(false, { error: 'TIMEOUT' }));
    sock.on('error', (e) => finish(false, { error: e.code || e.message }));
    sock.connect(port, host, () => finish(true, {}));

    // segurança extra: timeout “manual”
    setTimeout(() => finish(false, { error: 'TIMEOUT(hard)' }), timeoutMs + 200);
  });
}

export async function runDbDialSelfTest(databaseUrl) {
  let u;
  try { u = new NodeURL(String(databaseUrl).replace(/^['"]|['"]$/g, '')); }
  catch { return { parsed: null, error: 'BAD_URL' }; }

  const target = { host: u.hostname, port: Number(u.port || 5432) };

  const out = { target, tries: [] };
  // 3 tentativas só pra tirar dúvida de intermitência
  for (let i = 0; i < 3; i++) {
    const r = await tcpDialOnce({ host: target.host, port: target.port, timeoutMs: Number(process.env.DB_CONN_TIMEOUT_MS || 2000) });
    out.tries.push(r);
    await wait(150);
  }
  return out;
}
