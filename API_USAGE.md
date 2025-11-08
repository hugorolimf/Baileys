# Documentação da API Baileys (multi-user)

Esta documentação descreve como usar a API HTTP simples que gerencia múltiplas sessões do Baileys (WhatsApp). A API está implementada em `src/server.ts` e expõe endpoints para conectar, obter QR, verificar status, enviar mensagens e desconectar.

## Como rodar (resumo)

Requisitos:
- Node.js >= 20
- Git (opcional)

Instalação (recomendada para evitar scripts de lifecycle do repo):

```bash
cd path/to/Baileys
# instala dependências sem rodar os scripts preinstall/prepare do projeto
npm_config_ignore_scripts=true npm install
```

Iniciar servidor (desenvolvimento):

```bash
npx tsx ./src/server.ts
# ou
yarn start:api
```
A API por padrão escuta na porta 3009.

---


## Exemplos prontos em cURL

### Criar/retomar sessão
```bash
curl -X POST http://localhost:3009/connect \
    -H "Content-Type: application/json" \
    -d '{"userId":"cliente_abc"}'
```

curl http://localhost:3009/sessions

curl http://localhost:3009/status/<sessionId>


curl -X POST http://localhost:3009/send \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s_1762553680835_wms65u","jid":"5511999999999@s.whatsapp.net","text":"Teste após restart"}'

### Verificar status da sessão
```bash
curl http://localhost:3009/status/s_169941...
```

### Obter QR code (data URL)
```bash
curl http://localhost:3009/qr/s_169941...
```

### Enviar mensagem
```bash
curl -X POST http://localhost:3009/send \
    -H "Content-Type: application/json" \
    -d '{"sessionId":"s_169941...","jid":"5511999999999@s.whatsapp.net","text":"Olá do API"}'
```

### Desconectar sessão
```bash
curl -X POST http://localhost:3009/disconnect \
    -H "Content-Type: application/json" \
    -d '{"sessionId":"s_169941..."}'
```

---

Todos os endpoints aceitam/retornam JSON e ficam em `http://<host>:<port>` (ex.: `http://localhost:3009`).

### 1) POST /connect
Cria ou retoma uma sessão do Baileys. Se um `userId` for fornecido e já existir sessão associada, a sessão existente será retornada.

Request body (JSON):
- `sessionId` (opcional): string — força o uso de um sessionId específico
- `userId` (opcional): string — id do usuário do seu sistema (mapping user -> sessionId)

Exemplo:
```json
{ "userId": "cliente_abc" }
```

Resposta (exemplo):
```json
{ "sessionId":"s_169941...","status":"qr","qr":"data:image/png;base64,..." }
```
- `status` pode ser `connecting`, `qr`, `open`, `closed`, `already_exists`.
- `qr` quando presente pode ser um data URL (`data:image/png;base64,...`) que pode ser usado direto em `<img src="...">`.

Observação: o servidor também imprime um QR quadro pequeno no terminal para facilitar o desenvolvimento.

---

### 2) GET /status/:sessionId
Retorna o estado atual da sessão.
Agora inclui também informações de reconexão automática:

Campos adicionais:
- `lastDisconnect` (opcional): objeto com últimos dados da desconexão
    - `code`: statusCode (quando disponível) retornado pelo WhatsApp (ex.: 515, 503, 440, etc.)
    - `reason`: tag ou mensagem (ex.: `stream:error`, `conflict`, `ack`, `restart required`)
    - `at`: ISO timestamp do momento em que foi registrada
- `reconnectAttempts`: número de tentativas de reconexão realizadas desde a última conexão aberta bem-sucedida.

Comportamento de auto‑reconexão:
- Se a desconexão não for definitiva (não estiver em uma lista de códigos considerados finais como 401/403/405/428/440), o servidor agenda um retry com backoff exponencial (1s, 2s, 4s, 8s, até máximo 30s).
- Ao reconectar com sucesso (`connection === 'open'`), o contador `reconnectAttempts` é zerado.
- Para códigos finais (ex.: logout), a sessão permanece `closed` e não tenta reconectar.

Exemplo:
```
GET /status/s_169941...
```
Resposta (exemplo):
```json
{ "sessionId":"s_169941...","status":"open","qr":null }
```

---

### 3) GET /qr/:sessionId
Retorna o QR gerado para aquele sessionId como data URL (PNG). Útil para o frontend do cliente que quer exibir o QR sem depender do terminal.

Exemplo resposta:
```json
{ "sessionId":"s_169941...","qr":"data:image/png;base64,...." }
```

Se o QR ainda não foi gerado, retorna 404 com `{ error: 'qr not available yet' }`.

---

### 4) POST /send
Envia uma mensagem de texto usando a sessão especificada.

Request body (JSON):
- `sessionId`: string (obrigatório)
- `jid`: string (obrigatório) — jid do destinatário (`5511999999999@s.whatsapp.net`)
- `text`: string (obrigatório)

Exemplo:
```json
{ "sessionId":"s_169941...","jid":"5511999999999@s.whatsapp.net","text":"Olá do API" }
```

Resposta: objeto retornado pelo Baileys (confirmando envio) ou erro (500) em caso de falha.

---

### 5) POST /disconnect
Encerra e remove a sessão do mapa em memória (tenta `logout` antes se disponível).

Request body (JSON):
- `sessionId`: string (obrigatório)

Resposta:
```json
{ "ok": true }
```

---

## Fluxo típico de uso (exemplo)
1. Cliente chama `POST /connect` com `{ "userId": "cliente_abc" }`.
2. Server retorna `{ sessionId, status: 'qr', qr: 'data:image/png;base64,...' }`.
3. Frontend exibe `<img src="<qr>">` para o usuário escanear com o WhatsApp.
4. Depois do scan, o socket conecta e `GET /status/:sessionId` retorna `open`.
5. Cliente chama `POST /send` com `sessionId`, `jid` e `text` para enviar mensagens.

---

## Persistência de sessão
- As credenciais são salvas automaticamente em `./sessions/<sessionId>/` usando `useMultiFileAuthState`.
- Ao reiniciar o servidor, se os arquivos de credenciais existirem, a API tentará reconectar usando os dados salvos (sem novo QR), salvo se a sessão tiver sido desconectada/expirada pelo WhatsApp.

---

## Segurança e produção
Este servidor é um exemplo funcional. Antes de expor em produção, implemente:
- Autenticação (API key, JWT, OAuth) nos endpoints.
- HTTPS/TLS.
- Rate-limiting e validação de entrada.
- Proteção contra atuação por outros usuários (cada usuário só deve acessar suas sessões).
- Persistência centralizada (DB) se for usar múltiplos processos/hosts; sockets ficam em memória e não são compartilhados entre processos.

---

## Endpoints adicionais sugeridos (próximos passos)
- `GET /sessions?userId=...` — listar sessões ativas de um usuário
- `POST /connect/refresh` — forçar geração de novo QR (invalidar sessão atual)
- `POST /auth` — endpoint para provisionar/registrar API keys por usuário
- Suporte a envio de mídia: arquivos, imagens, áudios (usar `sock.sendMessage` com opções de media)

---

## Exemplo rápido em Node.js (fetch)
```js
// criar/retomar sessão
const res = await fetch('http://localhost:3009/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'cliente_abc' })
})
const data = await res.json()
console.log(data)
// se data.qr for dataURL, exiba no frontend

// enviar mensagem
await fetch('http://localhost:3009/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: data.sessionId, jid: '5511999999999@s.whatsapp.net', text: 'Olá' })
})
```

---

## Arquivos relevantes no projeto
- `src/server.ts` — implementação da API
- `src/Utils/use-multi-file-auth-state.ts` — armazenamento de credenciais por sessão
- `sessions/<sessionId>/` — pasta onde as credenciais são armazenadas para cada sessão

---

Se quiser, eu adapto a documentação para um formato mais amigável (OpenAPI / Swagger), ou adiciono exemplos prontos em cURL/JS/ts para cada endpoint e uma pequena UI estática para exibir o QR e enviar mensagens.

---

## Reconexão automática (detalhes técnicos)

Implementação (ver `src/server.ts`):
- Ao receber `connection === 'close'`, captura `lastDisconnect.error.output.statusCode` e `lastDisconnect.error.data.tag`.
- Mantém lista de códigos considerados finais: `401, 403, 405, 428, 440`.
- Para demais códigos, agenda `setTimeout` com backoff exponencial: `delay = min(1000 * 2^(n-1), 30000)`.
- Substitui o socket dentro do mesmo objeto de sessão (mantém `sessionId` e caminho de credenciais) para reaproveitar login sem novo QR quando possível.
- Reseta tentativa (`reconnectAttempts = 0`) quando `connection === 'open'`.

Exemplo de resposta após uma queda temporária:
```json
{
    "sessionId": "s_169941...",
    "status": "closed",
    "qr": null,
    "lastDisconnect": {
        "code": 515,
        "reason": "stream:error",
        "at": "2025-11-07T12:34:56.123Z"
    },
    "reconnectAttempts": 2
}
```

Logo após isso, quando a reconexão abrir:
```json
{
    "sessionId": "s_169941...",
    "status": "open",
    "qr": null,
    "reconnectAttempts": 0
}
```

---

## Troubleshooting rápido

| Sintoma | Possível causa | Ação sugerida |
|--------|----------------|---------------|
| Código 515 / 503 intermitente | Instabilidade lado WA ou handshake reiniciado | Confiar no backoff; apenas alertar se frequência muito alta |
| Código 440 / 405 / 401 | Sessão finalizada (logout / método não permitido) | Exigir novo QR: recriar sessão (`POST /connect`) |
| Ciclo infinito de reconexão sem abrir | Credenciais corrompidas ou bloqueio no número | Apagar pasta `sessions/<sessionId>` e reconectar via QR |
| `conflict` em `lastDisconnect.reason` | Outra instância usando a mesma conta | Encerrar outras sessões; garantir uma única execução |
| `ack` stream errored logo após enviar mídia | Possível condição específica de mídia | Testar envio de mídia menor; atualizar lib; abrir issue com logs |

Para reportar: inclua `lastDisconnect.raw` (log completo) e versão do Node/Baileys.
