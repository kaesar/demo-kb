import * as cdk from 'aws-cdk-lib/core';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { VectorIndex } from './vector-index';

/** Región fija del demo (Bedrock + AOSS + S3 en la misma región). */
export const KB_FIXED_REGION = 'us-east-1';

/** Modelos de embeddings soportados (ambos 1024 dims, mismo índice). */
export enum KbEmbeddingModel {
  /** Default: amazon.titan-embed-text-v2:0 (1024 dims, barato). */
  TITAN_V2_1024 = 'amazon.titan-embed-text-v2:0',
  /** Alterno multilingüe: cohere.embed-multilingual-v3 (1024 dims, mejor ES). */
  COHERE_MULTILINGUAL_V3 = 'cohere.embed-multilingual-v3',
}

export function resolveEmbeddingModel(value?: string): KbEmbeddingModel {
  if (!value) return KbEmbeddingModel.TITAN_V2_1024;
  const v = value.trim().toLowerCase();
  if (v === KbEmbeddingModel.TITAN_V2_1024 || v === 'titan-v2' || v === 'titan') {
    return KbEmbeddingModel.TITAN_V2_1024;
  }
  if (
    v === KbEmbeddingModel.COHERE_MULTILINGUAL_V3 ||
    v === 'cohere' ||
    v === 'cohere-multilingual'
  ) {
    return KbEmbeddingModel.COHERE_MULTILINGUAL_V3;
  }
  throw new Error(
    `embeddingModel no soportado: "${value}". Usa "titan-v2" o "cohere-multilingual".`,
  );
}

export interface KbStackProps extends cdk.StackProps {
  readonly kbName?: string;
  readonly collectionName?: string;
  readonly indexName?: string;
  readonly embeddingModel?: KbEmbeddingModel | string;
  /**
   * ARN IAM admin opcional para incluir en la DataPolicy AOSS
   * (operación manual: curl/smoke). Equivale al ADMIN_ARN del artículo.
   * También vía contexto: `-c adminArn=arn:aws:iam::123456789012:user/xxx`.
   */
  readonly adminArn?: string;
}

/**
 * Stack único demo-kb: S3 docs + OpenSearch Serverless VECTORSEARCH
 * + índice knn_vector + rol Bedrock + KnowledgeBase + DataSource S3.
 * Sin VPC (endpoints públicos + IAM least-privilege), espejo de demo-cx.
 * Todo DESTROY para liberar recursos con `cdk destroy`.
 */
export class KbStack extends cdk.Stack {
  public readonly kbId: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: KbStackProps = {}) {
    super(scope, id, props);

    if (this.region !== KB_FIXED_REGION && !cdk.Token.isUnresolved(this.region)) {
      throw new Error(
        `KbStack solo soporta ${KB_FIXED_REGION} (recibido ${this.region}). Despliega con env region fija.`,
      );
    }

    const kbName = props.kbName ?? this.node.tryGetContext('kbName') ?? 'kb-bedrock';
    const collectionName =
      props.collectionName ?? this.node.tryGetContext('collectionName') ?? 'kb-bedrock-collection';
    const indexName = props.indexName ?? this.node.tryGetContext('indexName') ?? 'kb-bedrock-index';
    const embeddingModel = resolveEmbeddingModel(
      (props.embeddingModel as string | undefined) ??
        (this.node.tryGetContext('embeddingModel') as string | undefined),
    );
    const embeddingModelArn = `arn:aws:bedrock:${KB_FIXED_REGION}::foundation-model/${embeddingModel}`;
    const dimension = 1024; // titan-v2 y cohere-multilingual-v3 usan 1024
    const adminArn =
      props.adminArn ?? (this.node.tryGetContext('adminArn') as string | undefined);

    // --- S3: documentos fuente (prefijo docs/) ---
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- OpenSearch Serverless: políticas + colección ---
    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'EncryptPolicy', {
      name: `${collectionName}-encrypt`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [{ Resource: [`collection/${collectionName}`], ResourceType: 'collection' }],
        AWSOwnedKey: true,
      }),
    });

    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `${collectionName}-net`,
      type: 'network',
      description: 'Public access (demo; en prod usar VPC)',
      policy: JSON.stringify([
        {
          Description: 'Public access',
          Rules: [
            { Resource: [`collection/${collectionName}`], ResourceType: 'collection' },
            { Resource: [`collection/${collectionName}`], ResourceType: 'dashboard' },
          ],
          AllowFromPublic: true,
        },
      ]),
    });

    // Rol IAM para Bedrock (confianza solo bedrock.amazonaws.com + SourceAccount)
    const kbRole = new iam.Role(this, 'KbRole', {
      roleName: undefined, // nombre generado: evita choques entre cuentas/entornos
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Rol para Bedrock KnowledgeBase: S3 + embeddings + AOSS',
    });
    // Endurece trust con SourceAccount (equivale al sed del script CLI)
    const defaultPolicy = kbRole.assumeRolePolicy;
    if (defaultPolicy) {
      // Nota: CDK ya pone bedrock.amazonaws.com; añadimos condición vía CfnRole si hay account conocido
      const cfnRole = kbRole.node.defaultChild as iam.CfnRole;
      if (cfnRole && !cdk.Token.isUnresolved(this.account)) {
        cfnRole.assumeRolePolicyDocument = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'bedrock.amazonaws.com' },
              Action: 'sts:AssumeRole',
              Condition: { StringEquals: { 'aws:SourceAccount': this.account } },
            },
          ],
        };
      }
    }

    const collection = new opensearchserverless.CfnCollection(this, 'Collection', {
      name: collectionName,
      type: 'VECTORSEARCH',
      description: 'Vectores demo-kb (Bedrock KB)',
      standbyReplicas: 'DISABLED', // demo: sin réplicas para minimizar OCU
    });
    collection.addResourceDependency(encryptionPolicy);
    collection.addResourceDependency(networkPolicy);
    collection.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Rol del handler del índice: se crea ANTES de la DataPolicy para
    // incluirlo como Principal sin ciclos (AOSS exige IAM + data-policy).
    const indexHandlerRole = new iam.Role(this, 'IndexHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Crea/elimina el índice knn_vector en AOSS (custom resource)',
    });
    indexHandlerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // Acceso a datos: rol KB (Bedrock) + rol handler (PUT/DELETE del índice).
    const dataPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataPolicy', {
      name: `${collectionName}-data`,
      type: 'data',
      description: 'KB access (Bedrock role)',
      policy: JSON.stringify([
        {
          Description: 'KB access',
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              Permission: [
                'aoss:CreateCollectionItems',
                'aoss:DescribeCollectionItems',
                'aoss:UpdateCollectionItems',
              ],
              ResourceType: 'collection',
            },
            {
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
              ],
              ResourceType: 'index',
            },
          ],
          Principal: [
            kbRole.roleArn,
            indexHandlerRole.roleArn,
            ...(adminArn ? [adminArn] : []),
          ],
        },
      ]),
    });
    dataPolicy.node.addDependency(collection);

    // --- Índice vectorial (Custom Resource; CFN no tiene L1) ---
    const vectorIndex = new VectorIndex(this, 'VectorIndex', {
      collectionEndpoint: collection.attrCollectionEndpoint,
      collectionArn: collection.attrArn,
      indexName,
      dimension,
      handlerRole: indexHandlerRole,
    });
    vectorIndex.node.addDependency(collection);
    vectorIndex.node.addDependency(dataPolicy);

    // --- Permisos del rol KB ---
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [docsBucket.bucketArn, `${docsBucket.bucketArn}/*`],
      }),
    );
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [embeddingModelArn],
      }),
    );
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        // La doc AOSS exige ambos para el data-plane (sin DashboardsAccessAll hay 403).
        actions: ['aoss:APIAccessAll', 'aoss:DashboardsAccessAll'],
        resources: [collection.attrArn],
      }),
    );

    // --- Knowledge Base ---
    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: kbName,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: { embeddingModelArn },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: collection.attrArn,
          vectorIndexName: indexName,
          fieldMapping: {
            vectorField: 'vector-field',
            textField: 'text-field',
            metadataField: 'metadata-field',
          },
        },
      },
    });
    kb.node.addDependency(vectorIndex.indexResource);

    // --- Data Source S3 (docs/) ---
    const dataSource = new bedrock.CfnDataSource(this, 'S3DataSource', {
      name: 's3-docs',
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      dataDeletionPolicy: 'DELETE', // al destruir DS se borran vectores ingeridos
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: docsBucket.bucketArn,
          inclusionPrefixes: ['docs/'],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: { maxTokens: 300, overlapPercentage: 20 },
        },
      },
    });

    this.kbId = kb.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;

    new cdk.CfnOutput(this, 'KbId', { value: kb.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId });
    new cdk.CfnOutput(this, 'DocsBucketName', { value: docsBucket.bucketName });
    new cdk.CfnOutput(this, 'CollectionArn', { value: collection.attrArn });
    new cdk.CfnOutput(this, 'CollectionEndpoint', { value: collection.attrCollectionEndpoint });
    new cdk.CfnOutput(this, 'IndexName', { value: indexName });
    new cdk.CfnOutput(this, 'EmbeddingModelArn', { value: embeddingModelArn });
    new cdk.CfnOutput(this, 'KbRoleArn', { value: kbRole.roleArn });
  }
}
