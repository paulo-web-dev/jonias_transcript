# jonIAs — Assistente de Aulas (anotações em tempo real)

## Visão geral

Sistema web em que o assistente **jonIAs** assiste a uma aula junto com o
aluno/professor: captura o áudio do microfone, transcreve a fala em tempo real e usa
a API do Claude para gerar anotações em tópicos, exibidas em cards conforme a aula
avança. Ao encerrar, gera um resumo estruturado. As aulas ficam salvas em SQLite,
protegidas por login, e podem ser revisitadas e exportadas em PDF ou Word.
Dark mode, pensado para projeção em sala.

## Identidade: o assistente jonIAs

- O robozinho assistente chama-se **jonIAs** — homenagem ao fundador da empresa,
  Jonias, com "IA" destacado no meio referenciando inteligência artificial.
- **Grafia oficial e obrigatória: `jonIAs`** — j minúsculo, IA maiúsculo, s
  minúsculo. Nunca "Jonias", "JonIAs", "jonias" ou "JONIAS" na interface.
- Na renderização, o "IA" recebe o gradiente de acento: `jon<span class="grad">IA</span>s`
  (no PDF/DOCX, o "IA" vai em ciano `#38d6e0`).
- Mensagens de estado têm personalidade leve e citam o nome:
  "jonIAs está ouvindo…", "jonIAs está anotando…", "jonIAs pausado",
  "jonIAs está salvando e resumindo a aula…", "jonIAs pronto para começar".
- Título/cabeçalho padrão: "jonIAs — Assistente de Aulas". Exportações levam o
  rodapé "Gerado por jonIAs — Assistente de Aulas".
- Manter essa consistência em qualquer tela, mensagem ou documento novo.

## Stack

- Frontend: HTML/CSS/JS puro, sem build (páginas: login, lista, sessão ao vivo, visualização).
- Backend: Node.js + Express 5 (`server.js`), sessão via `express-session` com store
  persistente em SQLite (`better-sqlite3-session-store`, tabela `sessions`).
- Autenticação: tabela `usuarios` com senha em **argon2id** (`argon2`, em `auth.js`);
  o primeiro admin é semeado no startup a partir de ADMIN_USER/ADMIN_PASS do .env.
- Banco: SQLite via `better-sqlite3` (`aula-ai.db`, no .gitignore; WAL + foreign keys),
  com **migrações versionadas por `PRAGMA user_version`** em `db.js`.
- Transcrição: **Web Speech API** (`SpeechRecognition`), `pt-BR`, contínuo com
  `interimResults` e **reinício automático** no `onend` (o Chrome derruba o
  reconhecimento periodicamente mesmo em modo contínuo).
- IA: `@anthropic-ai/sdk`, modelo **`claude-haiku-4-5`**.
- Exportação: **puppeteer-core** (usa o Chrome já instalado, `channel: "chrome"` —
  sem download de Chromium) para PDF; biblioteca **docx** para Word.

## Estrutura

```
aula-ai/
├── server.js        # Express: login/sessão, páginas, CRUD de aulas, IA, exportação
├── db.js            # conexão better-sqlite3 + migrações (PRAGMA user_version)
├── auth.js          # hash argon2id, rate limit progressivo do login, seed do admin
├── exportacao.js    # geração de PDF (puppeteer) e DOCX (docx) + template HTML
├── login.html       # tela de login              (rota /login)
├── aulas.html       # lista "Minhas Aulas"       (rota /aulas)
├── index.html       # sessão ao vivo             (rota /aula-ao-vivo?id=N)
├── aula-view.html   # visualização de encerrada  (rota /aula?id=N)
├── css/style.css    # tema dark completo (robô, listas, modais, login, view)
├── js/
│   ├── markdown.js  # conversor MD→HTML compartilhado (navegador + servidor/PDF)
│   ├── app.js       # sessão ao vivo (SpeechRecognition, blocos, encerramento)
│   ├── aulas.js     # lista, busca, criar/renomear/excluir
│   ├── aula-view.js # visualização + links de exportação
│   └── login.js
├── aula-ai.db       # SQLite (gerado em runtime, ignorado no git)
└── .env             # ANTHROPIC_API_KEY, ADMIN_USER, ADMIN_PASS, SESSION_SECRET
```

## Como rodar

```
npm install
copy .env.example .env    # preencher ANTHROPIC_API_KEY e SESSION_SECRET
npm start
```

**`SESSION_SECRET` é obrigatório** — sem ele o servidor sai na hora (a mensagem
mostra como gerar). `ADMIN_USER`/`ADMIN_PASS` são usados **apenas** para semear o
primeiro admin quando a tabela `usuarios` está vazia (padrão do example:
unyflex/unyflex); alterá-los depois não muda a senha no banco. As migrações rodam
sozinhas no `require("./db.js")` do startup.

Abrir `http://localhost:8000` no Chrome → redireciona para /login.
**Modo de teste:** `?bloco=30` na URL da sessão ao vivo reduz o bloco de 400
para 30 palavras.

## Banco de dados

Esquema versionado por `PRAGMA user_version` (migrações em `db.js`, uma transação
por versão; a migração 1 é o baseline idempotente — bancos novos e antigos passam
pelo mesmo caminho). Versão atual: **3**.

- `aulas(id, nome, data_criacao, status, duracao, transcricao_completa, resumo_md, usuario_id → usuarios)`
  — `status`: `em_andamento` | `encerrada`; `duracao` em segundos; datas em ISO 8601.
  `usuario_id` é nullable no esquema (limitação do ADD COLUMN do SQLite), mas o
  seed faz o backfill e a aplicação sempre grava o dono.
- `anotacoes(id, aula_id → aulas ON DELETE CASCADE, texto, timestamp)`.
- `usuarios(id, login UNIQUE, senha_hash argon2id, nome, papel='admin', ativo, criado_em)`.
- `login_bloqueios(chave PK, falhas, bloqueado_ate)` — chaves `ip:<ip>` e `login:<login>`
  do rate limit do login.
- `sessions` — criada/gerida pelo `better-sqlite3-session-store`.

## Rotas

| Rota | Descrição |
|---|---|
| `POST /api/login` | consulta a tabela `usuarios` (argon2), 401 genérico ("Usuário ou senha incorretos" — não revela se o login existe), 429 quando bloqueado pelo rate limit progressivo (por IP e por login, persistido em `login_bloqueios`) |
| `POST /api/logout` | destrói a sessão; **fica de propósito fora do middleware de auth** (logout com sessão expirada deve funcionar) |
| `GET/POST /api/aulas`, `GET/PATCH/DELETE /api/aulas/:id` | CRUD **filtrado por `usuario_id` da sessão** (lista aceita `?busca=`); aula alheia responde o mesmo 404 de inexistente |
| `POST /api/anotacoes` | gera tópicos via Claude; `aulaId` **obrigatório** (400) e validado contra o dono **antes** de chamar a API (404); aula encerrada → 409 (rechecado na hora da gravação — evita que resposta atrasada sobrescreva a transcrição final); grava tópicos + `transcricaoParcial` em transação. Se o navegador cair, perde-se no máximo o texto pendente desde o último bloco |
| `POST /api/aulas/:id/encerrar` | salva transcrição/duração/status **antes** de gerar o resumo; falha do resumo não perde dados (`erroResumo` no corpo, HTTP 200) |
| `GET /api/aulas/:id/pdf` e `/docx` | exportação com `Content-Disposition: attachment` |
| `POST /api/resumo` | mantida da Etapa 2 por compatibilidade |

Todas as rotas `/api/*` (exceto login e logout) e todas as páginas internas exigem
sessão com usuário **ativo** (sessão órfã/inativa é destruída); sem login: API
responde 401, páginas redirecionam para `/login`. A sessão guarda `usuarioId` e
`papel` (não existe mais o booleano `logado`). Os estáticos servidos são apenas
`/css` e `/js` (o `express.static` na raiz foi removido — não expõe
`server.js`/`.env`).

## Decisões de design importantes

- **jonIAs (o robô assistente)** em CSS puro, estados via `data-estado`: `idle`,
  `listening`, `processing`, `paused`; nome exibido sob o robô com "IA" em gradiente.
- **Blocos de ~400 palavras** (`PALAVRAS_POR_BLOCO`); nunca há dois blocos em voo
  (guarda de reentrada em `despacharBloco`); bloco que completa durante um
  processamento **bem-sucedido** é despachado em seguida. **Falha de API devolve o
  texto à fila**, mas o reenvio só acontece quando a próxima fala completar um
  bloco (evita loop de erros; toast discreto, sessão nunca trava).
- **Encerramento sem corrida**: `encerrarAula` espera o bloco em voo
  (`sessao.despachoAtual`) antes do bloco final e do `POST /encerrar`; no servidor,
  `/api/anotacoes` recusa gravar em aula encerrada (409) — o cliente descarta o
  bloco do 409 sem reenfileirar.
- **Microfone negado não encerra a aula**: `not-allowed` só interrompe a captura
  (banner + botão Iniciar reabilitado); a aula segue `em_andamento` e pode ser
  retomada na mesma tela.
- **Anti-repetição**: array `anotacoesGeradas` enviado como `anotacoesAnteriores`.
- **Structured outputs** (`output_config.format` + `json_schema`) garantem o JSON
  `{"topicos": []}` na API — não depende só do prompt.
- **PDF**: template HTML claro/imprimível (capa dark com gradiente → resumo →
  anotações com horários), renderizado pelo Chrome instalado via `puppeteer-core`
  com instância reutilizada (singleton). Se falhar, o erro sugere verificar o Chrome.
- **DOCX**: mesmo conteúdo com `Paragraph`/`TextRun` (títulos, bullets, negrito).
- **Markdown compartilhado**: `js/markdown.js` funciona no navegador
  (`window.MarkdownAula`) e no Node (usado pelo template do PDF).
- **Segurança**: HTML sempre escapado antes de renderizar; senhas só como hash
  argon2id no banco; `SESSION_SECRET` obrigatório (fail-fast, sem fallback);
  cookie `httpOnly` + `sameSite: lax` + `secure` quando `NODE_ENV=production`,
  12 h de validade; `trust proxy 1` para proxy reverso; login com resposta
  genérica, hash de sacrifício contra timing e bloqueio progressivo; toda rota
  de aula filtra por `usuario_id` da sessão.

## Roadmap

### ✅ Etapa 1 — Protótipo de interface + transcrição
### ✅ Etapa 2 — Integração real com a API da Anthropic
### ✅ Etapa 3 — Login, gerenciamento de aulas e exportação (concluída)
- Login com usuário fixo do .env, sessão em cookie assinado, botão Sair
- SQLite (better-sqlite3): aulas + anotações, salvas em tempo real
- Telas: Minhas Aulas (busca, nova, renomear, excluir), sessão ao vivo por aula,
  visualização de aula encerrada
- Exportação PDF (puppeteer-core + Chrome) e DOCX (docx)

### ✅ Etapa 0 — Endurecimento da base (concluída)
- Tabela `usuarios` (argon2id) com seed do primeiro admin; sessão por `usuarioId`
- Migrações de esquema com `PRAGMA user_version`
- `SESSION_SECRET` obrigatório; store de sessão persistente em SQLite
- Rate limit progressivo no login (por IP e por login); cookie `secure` em produção
- Posse de recursos por usuário (fim do IDOR em `/api/anotacoes`)
- Bugs corrigidos: corrida no encerramento (transcrição sobrescrita) e microfone
  negado que encerrava a aula permanentemente

### Etapa 4 — Ideias futuras (a priorizar)
- Multiusuário completo (cadastro/gestão de usuários — a base já existe na Etapa 0)
- Glossário automático de termos-chave
- Compartilhamento de resumo por link público somente leitura
- Seleção de idioma / tamanho de bloco pela interface
- Streaming do resumo para aulas longas
