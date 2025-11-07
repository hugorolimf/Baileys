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
A API por padrão escuta na porta 3000.

---

## Endpoints

Todos os endpoints aceitam/retornam JSON e ficam em `http://<host>:<port>` (ex.: `http://localhost:3000`).

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
const res = await fetch('http://localhost:3000/connect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: 'cliente_abc' })
})
const data = await res.json()
console.log(data)
// se data.qr for dataURL, exiba no frontend

// enviar mensagem
await fetch('http://localhost:3000/send', {
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
