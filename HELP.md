# HELP — demo-kb

## Costos (demo)

* OpenSearch Serverless cobra OCU/hora aunque no consultes (~colección VECTORSEARCH siempre activa). Destruye al terminar: `npm run destroy:kb:dev`.
* Embeddings Titan v2 / Cohere por tokens ingeridos; Nova Micro por `retrieve-and-generate` (barato).
* S3 docs insignificante. Sin VPC ni NAT.

## Límites y notas

* Todo en `us-east-1` (Bedrock, AOSS y S3 misma región). El stack falla claro en otra región.
* Modelos Amazon (Nova, Titan) vienen habilitados; Cohere/Anthropic requieren aceptar uso en consola (Bedrock → Model access) una vez por región.
* AOSS demo con red pública; en prod usar VPC + endpoint privado.
* Ingesta no es CFN: tras subir a `s3://<bucket>/docs/` ejecuta `npm run ingest`. Reindexar = repetir.
* `dataDeletionPolicy=DELETE`: al destruir el DS se borran vectores ingeridos; el bucket se vacía con `autoDeleteObjects`.

## Notas de implementación (errores reales encontrados)

* **PUT al índice devolvía 403 `gw-helper-deny` aunque la data-policy lo permitía:** AOSS exige el payload firmado (`x-amz-content-sha256`). `srv/vector-index/index.ts` lo incluye en todas las llamadas; sin él, ni el handler ni `curl` del artículo crean el índice.
* **`KnowledgeBase: no such index` segundos después de crear el índice:** Bedrock valida con retardo frente a AOSS. El custom resource verifica con GET y espera 120s de estabilización antes de reportar SUCCESS (ver `putIndexWithRetry` + sleep en el handler).
* **IAM data-plane AOSS:** el rol KB y el rol handler llevan `aoss:APIAccessAll` **y** `aoss:DashboardsAccessAll` (la doc exige ambos; sin ellos hay 403).
* **Operación manual:** pasa tu ARN con `-c adminArn=arn:aws:iam::<cuenta>:user/xxx` para incluirlo en la DataPolicy (equivale al `ADMIN_ARN` del artículo) y poder consultar el índice con `curl --aws-sigv4`.

## Errores comunes

* `ValidationException ... collection` → espera a ACTIVE (CDK ya depende de políticas/colección/índice; reintenta).
* `AccessDenied ... bedrock:InvokeModel` → habilita el modelo en Bedrock console `us-east-1`.
* `resource_already_exists` en índice → tolerado por el handler (mismo mapping).
* Smoke con 0 fragmentos → falta `npm run ingest` o `COMPLETE` aún no llega.
