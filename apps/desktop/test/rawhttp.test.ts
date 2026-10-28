import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { BodyDTO, RequestDTO, ResponseDTO } from '../src/shared/api';
import {
  binaryPlaceholder,
  parseRequest,
  parseResponse,
  repeaterRequestFrom,
  requestEditFrom,
  responseEditFrom,
  serializeRequest,
  serializeResponse,
  toCurl,
} from '../src/shared/rawhttp';

const body = (s: string | Buffer): BodyDTO => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return { size: b.length, text: Buffer.isBuffer(s) ? null : s, b64: b.toString('base64') };
};

const req = (over: Partial<RequestDTO> = {}): RequestDTO => ({
  method: 'POST',
  url: 'https://api.target.com/v1/users?id=1',
  httpVersion: '1.1',
  headers: [
    ['Host', 'api.target.com'],
    ['Content-Type', 'application/json'],
    ['Content-Length', '13'],
  ],
  body: body('{"isAdmin":0}'),
  ...over,
});

describe('rawhttp request', () => {
  it('serialize -> edit tanpa perubahan = undefined', () => {
    const r = req();
    assert.equal(requestEditFrom(r, serializeRequest(r)), undefined);
  });

  it('CRLF di body asli tidak dianggap perubahan (textarea menormalisasi ke LF)', () => {
    const r = req({ body: body('a=1\r\nb=2') });
    const text = serializeRequest(r).replace(/\r\n/g, '\n');
    assert.equal(requestEditFrom(r, text), undefined);
  });

  it('edit body -> Content-Length ikut update, header lain & casing tetap', () => {
    const r = req();
    const text = serializeRequest(r).replace('{"isAdmin":0}', '{"isAdmin":true}');
    const edit = requestEditFrom(r, text)!;
    assert.equal(edit.body, '{"isAdmin":true}');
    assert.deepEqual(edit.headers, [
      ['Host', 'api.target.com'],
      ['Content-Type', 'application/json'],
      ['Content-Length', '16'],
    ]);
    assert.equal(edit.method, undefined);
    assert.equal(edit.url, undefined);
  });

  it('Content-Length dihitung dalam byte (UTF-8), bukan karakter', () => {
    const r = req();
    const edit = requestEditFrom(r, serializeRequest(r).replace('{"isAdmin":0}', '{"n":"é"}'))!;
    assert.equal(edit.headers!.find(([k]) => k === 'Content-Length')![1], String(Buffer.byteLength('{"n":"é"}')));
  });

  it('updateContentLength=false -> header tidak disentuh', () => {
    const r = req();
    const edit = requestEditFrom(r, serializeRequest(r).replace('{"isAdmin":0}', '{}'), { updateContentLength: false })!;
    assert.equal(edit.headers, undefined);
    assert.equal(edit.body, '{}');
  });

  it('edit method + URL origin-form di-resolve ke origin asli', () => {
    const r = req();
    const text = serializeRequest(r).replace('POST https://api.target.com/v1/users?id=1', 'PUT /v1/users?id=2');
    const edit = requestEditFrom(r, text)!;
    assert.equal(edit.method, 'PUT');
    assert.equal(edit.url, 'https://api.target.com/v1/users?id=2');
  });

  it('header duplikat & urutan dipertahankan', () => {
    const p = parseRequest('GET / HTTP/1.1\nX-A: 1\nx-a: 2\nCookie: a=b; c=d\n\n');
    assert.deepEqual(p.headers, [
      ['X-A', '1'],
      ['x-a', '2'],
      ['Cookie', 'a=b; c=d'],
    ]);
  });

  it('nilai header boleh mengandung ":" dan kosong', () => {
    const p = parseRequest('GET / HTTP/1.1\nReferer: https://a.b:8443/x\nX-Empty:\n\n');
    assert.deepEqual(p.headers, [
      ['Referer', 'https://a.b:8443/x'],
      ['X-Empty', ''],
    ]);
  });

  it('header tanpa ":" -> error jelas', () => {
    assert.throws(() => parseRequest('GET / HTTP/1.1\nngawur\n\n'), /baris 2/);
  });

  it('body binary: placeholder utuh = body asli dipertahankan', () => {
    const r = req({ body: body(Buffer.from([0xff, 0x00, 0xfe])), headers: [['Host', 'api.target.com']] });
    const text = serializeRequest(r);
    assert.ok(text.includes(binaryPlaceholder(3)));
    assert.equal(requestEditFrom(r, text), undefined);
    // header diubah, body binary tetap tidak dikirim ulang
    const edit = requestEditFrom(r, text.replace('Host: api.target.com', 'Host: evil.com'))!;
    assert.equal(edit.body, undefined);
    assert.deepEqual(edit.headers, [['Host', 'evil.com']]);
    assert.throws(() => requestEditFrom(r, text.replace('3 bytes', '4 bytes')), /Placeholder/);
  });

  it('body yang mengandung baris kosong tetap utuh', () => {
    const r = req({ headers: [['Host', 'x']], body: body('a\n\nb\n') });
    assert.equal(parseRequest(serializeRequest(r)).body, 'a\n\nb\n');
  });
});

describe('rawhttp response', () => {
  const res: ResponseDTO = {
    statusCode: 200,
    statusMessage: 'OK',
    headers: [
      ['Content-Type', 'application/json'],
      ['Content-Length', '15'],
    ],
    body: body('{"role":"user"}'),
  };

  it('tanpa perubahan = undefined', () => {
    assert.equal(responseEditFrom(res, serializeResponse(res)), undefined);
  });

  it('edit status + body', () => {
    const text = serializeResponse(res).replace('200 OK', '201 Created').replace('"user"', '"admin"');
    const edit = responseEditFrom(res, text)!;
    assert.equal(edit.statusCode, 201);
    assert.equal(edit.statusMessage, 'Created');
    assert.equal(edit.body, '{"role":"admin"}');
    assert.equal(edit.headers!.find(([k]) => k === 'Content-Length')![1], '16');
  });

  it('status line invalid -> error', () => {
    assert.throws(() => parseResponse('200 OK\n\n'), /Status line/);
    assert.equal(parseResponse('HTTP/1.1 418\n\n').statusMessage, '');
  });
});

describe('repeater & curl', () => {
  it('origin-form + target base, Content-Length ditambah', () => {
    const r = repeaterRequestFrom('https://api.target.com:8443', 'POST /a/../b?x=1 HTTP/1.1\nHost: api.target.com\n\n{"a":1}');
    assert.equal(r.url, 'https://api.target.com:8443/a/../b?x=1');
    assert.deepEqual(r.headers.at(-1), ['Content-Length', '7']);
  });

  it('target kosong -> pakai header Host + https', () => {
    assert.equal(repeaterRequestFrom('', 'GET /x HTTP/1.1\nHost: h.test\n\n').url, 'https://h.test/x');
  });

  it('absolute URL di request line menang atas target', () => {
    assert.equal(repeaterRequestFrom('https://a.test', 'GET http://b.test/y HTTP/1.1\n\n').url, 'http://b.test/y');
  });

  it('Content-Length stale dikoreksi', () => {
    const r = repeaterRequestFrom('https://a.test', 'POST / HTTP/1.1\nContent-Length: 999\n\nabc');
    assert.deepEqual(r.headers, [['Content-Length', '3']]);
  });

  it('toCurl escape single quote, tanpa Content-Length', () => {
    const c = toCurl(req({ body: body(`{"q":"it's"}`) }));
    assert.ok(c.includes(`--data-binary '{"q":"it'\\''s"}'`));
    assert.ok(!/Content-Length/i.test(c));
  });
});
