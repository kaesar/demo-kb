#!/usr/bin/env node
// Lanza ingestion job KB->DS y espera a COMPLETE (troceo + embeddings + carga AOSS).
import { BedrockAgentClient, StartIngestionJobCommand, ListIngestionJobsCommand } from '@aws-sdk/client-bedrock-agent';
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

const out = await outputs();
const knowledgeBaseId = process.env.KB_ID ?? out.KbId;
const dataSourceId = process.env.DS_ID ?? out.DataSourceId;
if (!knowledgeBaseId || !dataSourceId) throw new Error('Faltan KbId/DataSourceId (despliega KbStack primero)');

const client = new BedrockAgentClient({ region: REGION });
const start = await client.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }));
const jobId = start.ingestionJob?.ingestionJobId;
console.log(`ingestionJob ${jobId} STARTED`);

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const list = await client.send(new ListIngestionJobsCommand({ knowledgeBaseId, dataSourceId, maxResults: 5 }));
  const job = list.ingestionJobSummaries?.find((j) => j.ingestionJobId === jobId) ?? list.ingestionJobSummaries?.[0];
  console.log(`status: ${job?.status}`);
  if (job?.status === 'COMPLETE') { console.log('Ingesta OK. Prueba: npm run smoke'); process.exit(0); }
  if (job?.status === 'FAILED') { console.error(JSON.stringify(job, null, 2)); process.exit(1); }
}
console.error('Timeout esperando ingesta');
process.exit(2);
