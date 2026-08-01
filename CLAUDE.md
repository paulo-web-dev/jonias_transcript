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
- Backend: Node.js + Express 5 (`server.js`), sessão via `express-session` (cookie assinado).
- Banco: SQLite via `better-sqlite3` (`aula-ai.db`, no .gitignore; WAL + foreign keys).
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
├── db.js            # conexão better-sqlite3 + criação das tabelas
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
copy .env.example .env    # preencher ANTHROPIC_API_KEY (login padrão: unyflex/unyflex)
npm start
```

Abrir `http://localhost:8000` no Chrome → redireciona para /login.
**Modo de teste:** `?bloco=30` na URL da sessão ao vivo reduz o bloco de 400
para 30 palavras.

## Banco de dados

- `aulas(id, nome, data_criacao, status, duracao, transcricao_completa, resumo_md)`
  — `status`: `em_andamento` | `encerrada`; `duracao` em segundos; datas em ISO 8601.
- `anotacoes(id, aula_id → aulas ON DELETE CASCADE, texto, timestamp)`.

## Rotas

| Rota | Descrição |
|---|---|
| `POST /api/login`, `POST /api/logout` | autenticação (ADMIN_USER/ADMIN_PASS do .env) |
| `GET/POST /api/aulas`, `GET/PATCH/DELETE /api/aulas/:id` | CRUD (lista aceita `?busca=`) |
| `POST /api/anotacoes` | gera tópicos via Claude; com `aulaId` grava cada tópico no banco na hora e salva `transcricaoParcial` (nada se perde se o navegador cair) |
| `POST /api/aulas/:id/encerrar` | salva transcrição/duração/status **antes** de gerar o resumo; falha do resumo não perde dados (`erroResumo` no corpo, HTTP 200) |
| `GET /api/aulas/:id/pdf` e `/docx` | exportação com `Content-Disposition: attachment` |
| `POST /api/resumo` | mantida da Etapa 2 por compatibilidade |

Todas as rotas `/api/*` (exceto login) e todas as páginas internas exigem sessão;
sem login: API responde 401, páginas redirecionam para `/login`. Os estáticos servidos
são apenas `/css` e `/js` (o `express.static` na raiz foi removido — não expõe
`server.js`/`.env`).

## Decisões de design importantes

- **jonIAs (o robô assistente)** em CSS puro, estados via `data-estado`: `idle`,
  `listening`, `processing`, `paused`; nome exibido sob o robô com "IA" em gradiente.
- **Blocos de ~400 palavras** (`PALAVRAS_POR_BLOCO`); bloco que completa durante um
  processamento é despachado em seguida; **falha de API devolve o texto à fila** e
  reenvia junto com o próximo bloco (toast discreto, sessão nunca trava).
- **Anti-repetição**: array `anotacoesGeradas` enviado como `anotacoesAnteriores`.
- **Structured outputs** (`output_config.format` + `json_schema`) garantem o JSON
  `{"topicos": []}` na API — não depende só do prompt.
- **PDF**: template HTML claro/imprimível (capa dark com gradiente → resumo →
  anotações com horários), renderizado pelo Chrome instalado via `puppeteer-core`
  com instância reutilizada (singleton). Se falhar, o erro sugere verificar o Chrome.
- **DOCX**: mesmo conteúdo com `Paragraph`/`TextRun` (títulos, bullets, negrito).
- **Markdown compartilhado**: `js/markdown.js` funciona no navegador
  (`window.MarkdownAula`) e no Node (usado pelo template do PDF).
- **Segurança**: HTML sempre escapado antes de renderizar; credenciais e chave só
  no `.env`; cookie `httpOnly` + `sameSite: lax`, 12 h de validade.

## Roadmap

### ✅ Etapa 1 — Protótipo de interface + transcrição
### ✅ Etapa 2 — Integração real com a API da Anthropic
### ✅ Etapa 3 — Login, gerenciamento de aulas e exportação (concluída)
- Login com usuário fixo do .env, sessão em cookie assinado, botão Sair
- SQLite (better-sqlite3): aulas + anotações, salvas em tempo real
- Telas: Minhas Aulas (busca, nova, renomear, excluir), sessão ao vivo por aula,
  visualização de aula encerrada
- Exportação PDF (puppeteer-core + Chrome) e DOCX (docx)

### Etapa 4 — Ideias futuras (a priorizar)
- Multiusuário real (tabela de usuários com senha hasheada, aulas por usuário)
- Glossário automático de termos-chave
- Compartilhamento de resumo por link público somente leitura
- Seleção de idioma / tamanho de bloco pela interface
- Streaming do resumo para aulas longas
