import { useMemo, useState } from 'react';
import type { BodyDTO, RawHeaders, RequestDTO, ResponseDTO } from '../../shared/api';
import { fmtBytes, header, hexDump, prettyBody } from '../util';

type Mode = 'pretty' | 'raw' | 'hex';
const MAX_TEXT = 2 * 1024 * 1024;

export function BodyView({ body, contentType }: { body: BodyDTO; contentType?: string }) {
  const pretty = useMemo(() => prettyBody(body, contentType), [body, contentType]);
  const [mode, setMode] = useState<Mode>('pretty');
  if (body.size === 0) return <div className="muted pad">(body kosong)</div>;

  const effective: Mode = body.text === null ? 'hex' : mode === 'pretty' && !pretty ? 'raw' : mode;
  let content: string;
  if (effective === 'hex') content = hexDump(body.b64);
  else if (effective === 'pretty') content = pretty!;
  else content = body.text!.length > MAX_TEXT ? body.text!.slice(0, MAX_TEXT) + '\n\n... (dipotong untuk tampilan)' : body.text!;

  return (
    <div className="body-view">
      <div className="body-toolbar">
        <span className="muted">
          {fmtBytes(body.size)}
          {contentType ? ` · ${contentType}` : ''}
          {body.text === null ? ' · binary' : ''}
        </span>
        <div className="seg">
          {(['pretty', 'raw', 'hex'] as Mode[]).map((m) => (
            <button
              key={m}
              className={effective === m ? 'on' : ''}
              disabled={(m !== 'hex' && body.text === null) || (m === 'pretty' && !pretty)}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <pre className="code">{content}</pre>
    </div>
  );
}

export function HeadersTable({ headers }: { headers: RawHeaders }) {
  if (!headers.length) return <div className="muted pad">(tanpa header)</div>;
  return (
    <table className="headers">
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <td className="hk">{k}</td>
            <td className="hv">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RequestView({ req }: { req: RequestDTO }) {
  return (
    <div className="message">
      <div className="startline">
        <b>{req.method}</b> {req.url} <span className="muted">HTTP/{req.httpVersion}</span>
      </div>
      <HeadersTable headers={req.headers} />
      <BodyView body={req.body} contentType={header(req.headers, 'content-type')} />
    </div>
  );
}

export function ResponseView({ res }: { res: ResponseDTO }) {
  return (
    <div className="message">
      <div className="startline">
        <b>{res.statusCode}</b> {res.statusMessage}
      </div>
      <HeadersTable headers={res.headers} />
      <BodyView body={res.body} contentType={header(res.headers, 'content-type')} />
    </div>
  );
}
