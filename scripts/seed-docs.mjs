#!/usr/bin/env node
// Sube docs de ejemplo a s3://<DocsBucket>/docs/ (origen de la KB).
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = 'us-east-1';
const STACK = process.env.STACK_NAME ?? 'KbStack';

async function outputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const out = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) out[o.OutputKey] = o.OutputValue;
  return out;
}

const DOCS = {
  'docs/agendamiento.txt': `Agendamiento médico (demo-kb):
- El documento 123 tiene cita de medicina general el 2026-10-10 a las 09:00 con Dra. Ruiz.
- Para reagendar, llamar en horario laboral Lun-Vie 8:00-18:00 America/Bogota.
- Opciones: agendar (1), consultar (2), cancelar (3), hablar con agente (0).`,
  'docs/horarios.txt': `Horarios clínica demo: Lun-Vie 8:00-18:00, Sáb 8:00-12:00.
Traslados complejos a cola AgendamientoMedico.`,
};

const bucket = process.argv[2];
const s3 = new S3Client({ region: REGION });

let target = bucket;
if (!target) {
  const out = await outputs();
  target = out.DocsBucketName;
}
if (!target) throw new Error('No se encontró DocsBucketName (pasa bucket como arg o despliega KbStack)');

for (const [key, body] of Object.entries(DOCS)) {
  await s3.send(new PutObjectCommand({ Bucket: target, Key: key, Body: body, ContentType: 'text/plain' }));
  console.log(`s3://${target}/${key} OK`);
}
console.log('Luego: npm run ingest');
