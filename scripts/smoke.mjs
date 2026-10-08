#!/usr/bin/env node
// Smoke post-deploy: retrieve + retrieve-and-generate contra la KB (Nova Micro).
import { BedrockAgentRuntimeClient, RetrieveCommand, RetrieveAndGenerateCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = 'us-east-1';
const STACK = process.env.STACK_NAME ?? 'KbStack';
const MODEL_ARN = `arn:aws:bedrock:${REGION}::foundation-model/amazon.nova-micro-v1:0`;

async function outputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const out = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) out[o.OutputKey] = o.OutputValue;
  return out;
}

const out = await outputs();
const knowledgeBaseId = process.env.KB_ID ?? out.KbId;
if (!knowledgeBaseId) throw new Error('Falta KbId (despliega KbStack primero)');

const client = new BedrockAgentRuntimeClient({ region: REGION });
const question = process.argv[2] ?? '¿Qué documento tengo registrado para agendamiento?';

const ret = await client.send(new RetrieveCommand({
  knowledgeBaseId,
  retrievalQuery: { text: question },
}));
console.log(`retrieve: ${ret.retrievalResults?.length ?? 0} fragmentos`);
for (const r of ret.retrievalResults?.slice(0, 2) ?? []) {
  console.log(`- score=${r.score?.toFixed(3)} ${(r.content?.text ?? '').slice(0, 160)}...`);
}

const rag = await client.send(new RetrieveAndGenerateCommand({
  input: { text: question },
  retrieveAndGenerateConfiguration: {
    type: 'KNOWLEDGE_BASE',
    knowledgeBaseConfiguration: { knowledgeBaseId, modelArn: MODEL_ARN },
  },
}));
console.log(`\nRAG:\n${rag.output?.text}`);
