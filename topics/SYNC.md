# topics/

Copy of the topic-creation code of generador-service (commit fc60ac6), used by POST /aviso-tema-auto.

- topics/lib, topics/prompts and topics/data are verbatim copies of src/lib, src/prompts and src/data in generador-service. Change them there first and copy them here.
- topics/avisoTema.js is assembled from src/server.js of generador-service (classification block and the /aviso-tema-auto handler).
- topics/env.js fills in the defaults this service lacks (subject KV, organization KV, Worker URL and key) so no new environment variables are needed.
- The Worker calls this route first and falls back to generador-service when it is unavailable.
- topics/graph/store.js holds only markGraphDirty from src/graph/store.js of generador-service. The graph builder itself lives only in generador-service (private).
