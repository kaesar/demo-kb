#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { KbStack, KB_FIXED_REGION } from '../lib/kb-stack';

/**
 * App única demo-kb. Región fija us-east-1: Bedrock + AOSS + S3
 * deben vivir en la misma región (ver Amazon-Bedrock.md §§1-5).
 * Futuro KbLexStack recibirá `kbId` por contexto (-c kbId=...),
 * mismo desacoplo que CxConnectStack <-> patientLookupArn en demo-cx.
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: KB_FIXED_REGION,
};

new KbStack(app, 'KbStack', {
  env,
  description: 'Demo-KB: Bedrock Knowledge Base (S3 docs + OpenSearch Serverless vector).',
});

app.synth();
