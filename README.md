# Demo-KB: Bedrock Knowledge Base + S3 + OpenSearch Serverless (CDK)

Pieza IaC complementaria a `demo-cx`: base de conocimiento RAG
`Docs (S3 docs/) → Bedrock KB → Titan/Cohere embeddings → OpenSearch Serverless (knn_vector 1024)`.

* Stack único `KbStack`, región fija `us-east-1`, nombre KB `kb-bedrock`.
* Sin VPC por diseño (como `demo-cx`).
* Todo `DESTROY`: `npm run destroy:kb:dev` libera bucket, colección, rol, KB y DS.
* Futuro `KbLexStack` consumirá `KbId` por contexto `-c kbId=...` (mismo desacoplo que `CxConnectStack -c patientLookupArn`).

## Arquitectura

```mermaid
flowchart LR
    Docs["S3 DocsBucket<br/>(docs/*.txt)"] --> DS["DataSource<br/>s3-docs"]
    DS --> KB["Bedrock KB<br/>kb-bedrock (VECTOR)"]
    KB -- "InvokeModel<br/>Titan v2 / Cohere (1024)" --> Emb["Embeddings"]
    KB --> AOSS["OpenSearch Serverless<br/>VECTORSEARCH + knn_vector"]
    Handler["Lambda VectorIndex<br/>(custom resource)"] -.-> AOSS
    KbRole["IAM KbRole<br/>(S3 + InvokeModel + aoss)"] -.-> KB
    Lex["Futuro KbLexStack<br/>(Lex + Connect)"] -- "RetrieveAndGenerate<br/>(-c kbId=...)" --> KB
```

Flujo: `docs/ (S3)` → ingesta (`troceo 300/20` + embeddings) → vectores en `kb-bedrock-index` → `retrieve` / `retrieve-and-generate` (Nova Micro). El índice lo crea la Lambda `VectorIndex` (CFN no tiene L1 para índices) con espera de estabilización para la validación de Bedrock.

## Estructura

```
kb/
├── cdk/bin/kb.ts              # App única: KbStack (región fija us-east-1)
├── cdk/lib/kb-stack.ts        # S3 + AOSS + rol + KB + DataSource (+ enum embeddings)
├── cdk/lib/vector-index.ts    # Construct índice knn_vector (custom resource)
├── cdk/test/kb.test.ts        # Tests synth (sin VPC, recursos DESTROY)
├── cdk/cdk.json               # App + feature flags (CLI corre desde aquí)
├── srv/vector-index/index.ts  # Handler PUT/GET/DELETE del índice (SigV4 aoss)
├── scripts/seed-docs.mjs      # Sube docs ejemplo a s3://<bucket>/docs/
├── scripts/ingest.mjs         # StartIngestionJob + espera COMPLETE
├── scripts/smoke.mjs          # retrieve + retrieve-and-generate (Nova Micro)
└── README.md / HELP.md / DEPLOY.md
```

## Uso

```bash
npm ci
npm run build      # tsc --noEmit
npm test           # jest synth
npm run synth
npm run deploy:kb:dev
npm run seed       # sube docs ejemplo a s3://<bucket>/docs/
npm run ingest     # StartIngestionJob + espera COMPLETE
npm run smoke      # retrieve + retrieve-and-generate (Nova Micro)
npm run destroy:kb:dev
```

Alternar embeddings (ambos 1024 dims, mismo índice):

```bash
cd cdk && cdk deploy KbStack -c embeddingModel=cohere-multilingual --require-approval never
```

Ver `HELP.md` (costos/límites) y `DEPLOY.md` (paso a paso + Lex futuro).
