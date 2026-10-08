# DEPLOY — demo-kb

Requiere Node >= 22, AWS CLI v2, `us-east-1`, `npx cdk bootstrap aws://<account>/us-east-1` una vez.

```bash
npm ci
npm run build && npm test
npm run synth
npm run deploy:kb:dev
npm run seed
npm run ingest
npm run smoke
```

Outputs útiles (`KbId`, `DataSourceId`, `DocsBucketName`, `CollectionEndpoint`):

```bash
aws cloudformation describe-stacks --stack-name KbStack --region us-east-1 \
  --query "Stacks[0].Outputs" --output table
```

## Liberar recursos

```bash
npm run destroy:kb:dev
aws opensearchserverless batch-get-collection --names kb-bedrock-collection --region us-east-1 || echo "colección eliminada"
```

## Conectar Lex futuro (pieza 3)

1. Nuevo `KbLexStack` en este repo con bot Lex + Lambda `lex-kb-query` (`bedrock:RetrieveAndGenerate` sobre `kbId`).
2. Despliegue desacoplado como `demo-cx`:
   `npx cdk deploy KbLexStack -c kbId=<KbId de arriba> --require-approval never`.
3. `demo-cx` no se modifica: su flow `AgendamientoMedico` invocará al bot Lex, y Lex consultará esta KB.
