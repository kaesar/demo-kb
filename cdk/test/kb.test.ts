import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import {
  KbStack,
  KbEmbeddingModel,
  KbVectorStore,
  resolveEmbeddingModel,
  resolveVectorStore,
} from '../lib/kb-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

describe('Demo-KB stack synthesizes with no VPC and destroyable resources', () => {
  test('Por defecto usa S3 Vectors: bucket + índice nativos, sin AOSS ni Lambdas', () => {
    const app = new cdk.App();
    const stack = new KbStack(app, 'TKproper', { env: ENV });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
    t.resourceCountIs('AWS::S3Vectors::Index', 1);
    t.resourceCountIs('AWS::S3Vectors::VectorBucketPolicy', 1);
    t.resourceCountIs('AWS::OpenSearchServerless::Collection', 0);
    t.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
    t.resourceCountIs('AWS::Bedrock::DataSource', 1);

    t.hasResourceProperties('AWS::Bedrock::KnowledgeBase', { Name: 'kb-bedrock' });
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('S3_VECTORS');
    expect(json).not.toContain('OPENSEARCH_SERVERLESS');
    expect(json).toContain('amazon.titan-embed-text-v2:0');
    expect(json).toContain('docs/');

    // Sin custom resource de índice: solo la Lambda de autoDeleteObjects del bucket S3
    const lambdas = t.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBe(1);
    t.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
  });

  test('vectorStore=aoss crea S3 + AOSS + rol + KB + DS con kb-bedrock', () => {
    const app = new cdk.App();
    const stack = new KbStack(app, 'TKaoss', { env: ENV, vectorStore: KbVectorStore.AOSS });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.resourceCountIs('AWS::S3Vectors::VectorBucket', 0);
    t.resourceCountIs('AWS::OpenSearchServerless::Collection', 1);
    t.resourceCountIs('AWS::OpenSearchServerless::SecurityPolicy', 2);
    t.resourceCountIs('AWS::OpenSearchServerless::AccessPolicy', 1);
    t.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
    t.resourceCountIs('AWS::Bedrock::DataSource', 1);

    t.hasResourceProperties('AWS::Bedrock::KnowledgeBase', { Name: 'kb-bedrock' });
    t.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
      Name: 'kb-bedrock-collection',
      Type: 'VECTORSEARCH',
    });
    // fieldMapping consistente con el handler del índice
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('OPENSEARCH_SERVERLESS');
    expect(json).toContain('vector-field');
    expect(json).toContain('text-field');
    expect(json).toContain('metadata-field');
    expect(json).toContain('docs/');

    // Sin VPC: ninguna Lambda declara VpcConfig
    const lambdas = t.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBeGreaterThan(0);
    Object.values(lambdas).forEach((fn: any) => {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    });
  });

  test('embeddingModel cohere alternable', () => {
    const app = new cdk.App();
    const stack = new KbStack(app, 'TKcohere', {
      env: ENV,
      embeddingModel: KbEmbeddingModel.COHERE_MULTILINGUAL_V3,
    });
    const json = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(json).toContain('cohere.embed-multilingual-v3');
  });

  test('resolveEmbeddingModel valida aliases y rechaza otros', () => {
    expect(resolveEmbeddingModel(undefined)).toBe(KbEmbeddingModel.TITAN_V2_1024);
    expect(resolveEmbeddingModel('titan-v2')).toBe(KbEmbeddingModel.TITAN_V2_1024);
    expect(resolveEmbeddingModel('cohere-multilingual')).toBe(
      KbEmbeddingModel.COHERE_MULTILINGUAL_V3,
    );
    expect(() => resolveEmbeddingModel('nova')).toThrow(/no soportado/);
  });

  test('resolveVectorStore: default s3-vectors, aliases y rechazo', () => {
    expect(resolveVectorStore(undefined)).toBe(KbVectorStore.S3_VECTORS);
    expect(resolveVectorStore('aoss')).toBe(KbVectorStore.AOSS);
    expect(resolveVectorStore('opensearch')).toBe(KbVectorStore.AOSS);
    expect(() => resolveVectorStore('aurora')).toThrow(/no soportado/);
  });

  test('región distinta a us-east-1 falla claro', () => {
    const app = new cdk.App();
    expect(
      () => new KbStack(app, 'TKregion', { env: { account: '123456789012', region: 'eu-west-1' } }),
    ).toThrow(/us-east-1/);
  });
});
