import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { KbStack, KbEmbeddingModel, resolveEmbeddingModel } from '../lib/kb-stack';

describe('Demo-KB stack synthesizes with no VPC and destroyable resources', () => {
  test('KbStack crea S3 + AOSS + rol + KB + DS con kb-bedrock por defecto', () => {
    const app = new cdk.App();
    const stack = new KbStack(app, 'TKproper', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 1);
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
    expect(json).toContain('vector-field');
    expect(json).toContain('text-field');
    expect(json).toContain('metadata-field');
    expect(json).toContain('amazon.titan-embed-text-v2:0');
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
      env: { account: '123456789012', region: 'us-east-1' },
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

  test('región distinta a us-east-1 falla claro', () => {
    const app = new cdk.App();
    expect(
      () => new KbStack(app, 'TKregion', { env: { account: '123456789012', region: 'eu-west-1' } }),
    ).toThrow(/us-east-1/);
  });
});
