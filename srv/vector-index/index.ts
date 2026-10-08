import * as https from 'node:https';
import * as crypto from 'node:crypto';
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
  Context,
} from 'aws-lambda';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const aws4 = require('aws4');

const VECTOR_FIELD = 'vector-field';
const TEXT_FIELD = 'text-field';
const METADATA_FIELD = 'metadata-field';
/** SHA-256 del string vacío (para GET/DELETE sin body). */
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function normalizeEndpoint(raw: string): string {
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function request(opts: {
  endpoint: string;
  region: string;
  method: string;
  path: string;
  body?: string;
}): Promise<{ status: number; text: string }> {
  const host = normalizeEndpoint(opts.endpoint);
  const url = new URL(`https://${host}${opts.path}`);
  // AOSS exige payload firmado: sin x-amz-content-sha256 el PUT devuelve
  // 403 (gw-helper-deny) aunque la data-policy lo permita.
  const payloadHash =
    opts.body !== undefined
      ? crypto.createHash('sha256').update(opts.body).digest('hex')
      : EMPTY_SHA256;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Host: url.host,
    'x-amz-content-sha256': payloadHash,
  };
  if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));

  const signed = aws4.sign(
    {
      host: url.host,
      path: url.pathname,
      method: opts.method,
      headers,
      body: opts.body,
      service: 'aoss',
      region: opts.region,
    },
    {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  );

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: opts.method,
        headers: signed.headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function sendResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: 'SUCCESS' | 'FAILED',
  data: Record<string, string> = {},
  reason?: string,
): Promise<void> {
  const fallbackId =
    (event.ResourceProperties as Record<string, string> | undefined)?.IndexName ?? 'kb-index';
  const physicalId =
    event.RequestType === 'Create'
      ? fallbackId
      : (event as { PhysicalResourceId?: string }).PhysicalResourceId ?? fallbackId;
  const body = JSON.stringify({
    Status: status,
    Reason: reason ?? `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: physicalId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });
  await new Promise<void>((resolve, reject) => {
    const u = new URL(event.ResponseURL);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'PUT', headers: { 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function putIndexWithRetry(opts: {
  endpoint: string;
  region: string;
  indexName: string;
  dimension: number;
}): Promise<void> {
  const body = JSON.stringify({
    settings: { 'index.knn': true },
    mappings: {
      properties: {
        [VECTOR_FIELD]: {
          type: 'knn_vector',
          dimension: opts.dimension,
          method: { name: 'hnsw', engine: 'faiss' },
        },
        [TEXT_FIELD]: { type: 'text' },
        [METADATA_FIELD]: { type: 'text' },
      },
    },
  });
  // La colección tarda en pasar a ACTIVE y la data-policy en propagarse:
  // reintentar 403/404/5xx durante ~4 min.
  let last = '';
  for (let attempt = 1; attempt <= 16; attempt++) {
    const res = await request({
      endpoint: opts.endpoint,
      region: opts.region,
      method: 'PUT',
      path: `/${opts.indexName}`,
      body,
    });
    console.log(`PUT índice intento ${attempt}/16: ${res.status} ${res.text.slice(0, 300)}`);
    if (res.status === 200 || res.status === 201) {
      await verifyIndex(opts);
      return;
    }
    if (res.status === 400 && res.text.includes('resource_already_exists')) {
      await verifyIndex(opts);
      return;
    }
    last = `${res.status} ${res.text}`;
    if (res.status === 403 || res.status === 404 || res.status >= 500) {
      console.log(`Índice no listo (intento ${attempt}/16): ${last}. Reintentando...`);
      await sleep(15000);
      continue;
    }
    throw new Error(`Put index failed: ${last}`);
  }
  throw new Error(`Put index failed tras reintentos: ${last}`);
}

/** GET del índice hasta que la data-plane lo sirve (evita "no such index" en la KB). */
async function verifyIndex(opts: { endpoint: string; region: string; indexName: string }): Promise<void> {
  let last = '';
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await request({
      endpoint: opts.endpoint,
      region: opts.region,
      method: 'GET',
      path: `/${opts.indexName}`,
    });
    if (res.status === 200) {
      console.log(`Índice ${opts.indexName} verificado con GET (intento ${attempt}).`);
      return;
    }
    last = `${res.status} ${res.text}`;
    console.log(`GET índice no listo (intento ${attempt}/12): ${last}. Reintentando...`);
    await sleep(10000);
  }
  throw new Error(`Índice creado pero no visible vía GET tras reintentos: ${last}`);
}

export async function handler(event: CloudFormationCustomResourceEvent, context: Context): Promise<void> {
  const props = event.ResourceProperties as Record<string, string> | undefined;
  const endpoint = props?.CollectionEndpoint ?? process.env.COLLECTION_ENDPOINT ?? '';
  const indexName = props?.IndexName ?? process.env.INDEX_NAME ?? '';
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const dimension = Number(props?.Dimension ?? process.env.DIMENSION ?? '1024');
  let response: CloudFormationCustomResourceResponse | null = null;

  try {
    if (!endpoint || !indexName) throw new Error('Missing CollectionEndpoint/IndexName');

    if (event.RequestType === 'Delete') {
      const res = await request({ endpoint, region, method: 'DELETE', path: `/${indexName}` });
      if (res.status !== 200 && res.status !== 404) throw new Error(`Delete index failed: ${res.status} ${res.text}`);
      await sendResponse(event, context, 'SUCCESS', { IndexName: indexName });
      return;
    }

    await putIndexWithRetry({ endpoint, region, indexName, dimension });
    // Bedrock valida el índice segundos después: darle ventana de
    // convergencia AOSS (el PUT+GET propio no basta; "no such index" si no).
    console.log('Índice listo. Esperando 120s de estabilización para validación Bedrock...');
    await sleep(120000);
    response = { Status: 'SUCCESS' } as unknown as CloudFormationCustomResourceResponse;
    await sendResponse(event, context, 'SUCCESS', { IndexName: indexName });
    void response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (event.RequestType === 'Delete') {
      // No bloquear destroy por índice ya inexistente
      await sendResponse(event, context, 'SUCCESS', { IndexName: indexName }, message);
      return;
    }
    await sendResponse(event, context, 'FAILED', {}, message);
  }
}
