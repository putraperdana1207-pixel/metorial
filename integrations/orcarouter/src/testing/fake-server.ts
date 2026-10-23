import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  rawBody: string;
};

export type FakeResponse = {
  status?: number;
  body?: unknown;
};

export type FakeServer = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

let parseBody = (raw: string) => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export let startFakeServer = async (
  handler: (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>
): Promise<FakeServer> => {
  let requests: RecordedRequest[] = [];

  let server = createServer(async (req, res) => {
    let chunks: Buffer[] = [];
    for await (let chunk of req) {
      chunks.push(chunk as Buffer);
    }

    let rawBody = Buffer.concat(chunks).toString('utf8');
    let url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: parseBody(rawBody),
      rawBody
    };

    requests.push(recorded);

    let result = await handler(recorded);
    res.statusCode = result.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result.body ?? {}));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  let address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      })
  };
};

let envKeys = [
  'ORCAROUTER_BASE_URL',
  'ORCAROUTER_AUTH_BASE_URL',
  'ORCAROUTER_API_BASE_URL'
] as const;

export let withEnv = async <T>(
  values: Partial<Record<(typeof envKeys)[number], string>>,
  run: () => Promise<T>
) => {
  let previous = new Map<string, string | undefined>();
  for (let key of envKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    for (let [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }

    return await run();
  } finally {
    for (let key of envKeys) {
      let value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};
