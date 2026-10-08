import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface VectorIndexProps {
  readonly collectionEndpoint: string;
  readonly collectionArn: string;
  readonly indexName: string;
  readonly dimension?: number;
  /**
   * Rol pre-creado para el handler del índice. Debe existir ANTES de la
   * DataPolicy AOSS para poder incluirlo como Principal sin ciclos.
   * Si se omite, se crea uno interno (solo para tests).
   */
  readonly handlerRole?: iam.IRole;
}

/**
 * Crea/elimina el índice knn_vector en OpenSearch Serverless vía
 * Custom Resource (CFN no tiene L1 para índices).
 * fieldMapping fijo: vector-field / text-field / metadata-field.
 */
export class VectorIndex extends Construct {
  public readonly indexResource: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: VectorIndexProps) {
    super(scope, id);

    const dimension = props.dimension ?? 1024;

    const fnLogs = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const onEvent = new NodejsFunction(this, 'Handler', {
      entry: path.join(__dirname, '..', '..', 'srv', 'vector-index', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      // Reintentos PUT (4 min) + verificación GET + estabilización 120s para Bedrock.
      timeout: cdk.Duration.minutes(10),
      logGroup: fnLogs,
      role: props.handlerRole as iam.IRole | undefined,
      environment: {
        COLLECTION_ENDPOINT: props.collectionEndpoint,
        INDEX_NAME: props.indexName,
        DIMENSION: String(dimension),
      },
    });
    // Grant IAM (la DataPolicy AOSS con este rol como Principal la pone el stack).
    // Ambos permisos: la doc AOSS los exige para el data-plane (403 sin ellos).
    (onEvent.role as iam.IRole).addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll', 'aoss:DashboardsAccessAll'],
        resources: [props.collectionArn],
      }),
    );

    const providerLogs = new logs.LogGroup(this, 'ProviderLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const provider = new customResources.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      logGroup: providerLogs,
    });

    this.indexResource = new cdk.CustomResource(this, 'Index', {
      serviceToken: provider.serviceToken,
      properties: {
        CollectionEndpoint: props.collectionEndpoint,
        IndexName: props.indexName,
        Dimension: String(dimension),
      },
    });
  }
}
