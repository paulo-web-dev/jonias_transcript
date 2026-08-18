# jonIAs — Assistente de Aulas (anotações em tempo real)

## Visão geral

Sistema web em que o assistente **jonIAs** assiste a uma aula junto com o
aluno/professor: captura o áudio do microfone, transcreve a fala em tempo real e usa
a API do Claude para gerar anotações em tópicos, exibidas em cards conforme a aula
avança. Ao encerrar, gera um resumo estruturado. As aulas ficam salvas em SQLite,
protegidas por login, e podem ser revisitadas e exportadas em PDF ou Word.
Dark mode, pensado para projeção em sala.

O jonIAs também é a **central de dados e IA** da operação comercial: ingere o CDR
do PABX (upload de CSV) e as oportunidades do CRM **Omie** (upload da planilha
.xlsx "Planilha de Oportunidades"), sincroniza matrículas e turmas do MySQL da
Unyflex como cópia local, e unifica tudo no modelo canônico (tabela `pessoas`) —
base para as métricas e relatórios da Etapa 2. (O importador anterior, do
Ramper, foi substituído pelo do Omie.)

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
- Ingestão: **csv-parse** (CDR, upload como text/plain via `file.text()`);
  **exceljs** (planilha .xlsx do Omie, upload binário via `arrayBuffer()` +
  `express.raw`); **mysql2** para a sincronização somente-leitura da Unyflex.

## Estrutura

```
aula-ai/
├── server.js        # Express: login/sessão, páginas, CRUD de aulas, IA, exportação
├── db.js            # conexão better-sqlite3 + migrações (PRAGMA user_version)
├── auth.js          # hash argon2id, rate limit progressivo do login, seed do admin
├── importacao.js    # ingestão: CDR do PABX (CSV) e oportunidades do Omie (.xlsx)
├── sincronizacao.js # sync incremental do MySQL Unyflex → SQLite + cruzamento
├── exportacao.js    # geração de PDF (puppeteer) e DOCX (docx) + template HTML
├── login.html       # tela de login              (rota /login)
├── aulas.html       # lista "Minhas Aulas"       (rota /aulas)
├── index.html       # sessão ao vivo             (rota /aula-ao-vivo?id=N)
├── aula-view.html   # visualização de encerrada  (rota /aula?id=N)
├── central.html     # central de dados           (rota /central)
├── relatorios.html  # períodos e métricas        (rota /relatorios)
├── saude.html       # saúde dos dados            (rota /saude)
├── tv.html          # painel público da sala     (rota /tv?token=)
├── metricas.js      # motor de métricas em SQL puro + saúde + payload TV
├── css/style.css    # tema dark completo (robô, listas, modais, login, view, central)
├── js/
│   ├── markdown.js  # conversor MD→HTML compartilhado (navegador + servidor/PDF)
│   ├── app.js       # sessão ao vivo (SpeechRecognition, blocos, encerramento)
│   ├── aulas.js     # lista, busca, criar/renomear/excluir
│   ├── aula-view.js # visualização + links de exportação
│   ├── central.js   # uploads, sincronização e histórico de ingestões
│   └── login.js
├── aula-ai.db       # SQLite (gerado em runtime, ignorado no git)
└── .env             # ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_*, MYSQL_*, TV_TOKEN
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
pelo mesmo caminho). Versão atual: **11**.

- `aulas(id, nome, data_criacao, status, duracao, transcricao_completa, resumo_md, usuario_id → usuarios)`
  — `status`: `em_andamento` | `encerrada`; `duracao` em segundos; datas em ISO 8601.
  `usuario_id` é nullable no esquema (limitação do ADD COLUMN do SQLite), mas o
  seed faz o backfill e a aplicação sempre grava o dono.
- `anotacoes(id, aula_id → aulas ON DELETE CASCADE, texto, timestamp)`.
- `usuarios(id, login UNIQUE, senha_hash argon2id, nome, papel='admin', ativo, criado_em)`.
- `login_bloqueios(chave PK, falhas, bloqueado_ate)` — chaves `ip:<ip>` e `login:<login>`
  do rate limit do login.
- `sessions` — criada/gerida pelo `better-sqlite3-session-store`.

Central de dados (migração 4; datas/horas operacionais em **horário local**, sem Z):

- `pessoas(id, nome, ramal UNIQUE, crm_user_id UNIQUE, wallet_nome UNIQUE, ativo, entra_feedback, nomes_alternativos)`
  — unifica os identificadores dos consultores; `nomes_alternativos` é um JSON
  array com os nomes completos como aparecem no "Vendedor" do Omie; seed com os
  6 atuais (Renato com `entra_feedback = 0` e `entra_painel = 0`; `crm_user_id` do Frederico pendente). `tipo`: consultor | canal; `entra_painel` controla as visões de prospecção da TV.
- `importacoes(id, tipo cdr|oportunidades|mysql, arquivo_nome, hash_sha256, linhas_*, registros_novos/atualizados/identicos, detalhes_json, status, erro, usuario_id, iniciado/concluido_em)`
  — auditoria de toda ingestão: cada número tem origem explicável.
- `ligacoes(id, cdr_id UNIQUE, data_hora, ramal, pessoa_id, numero_a/b, sentido, fila, duracao_seg, atendida, eventos, gravacao, tem_evento_atendida, evento_falha, atendida_em, encerrada_em, tempo_toque_seg, tempo_conversa_seg, importacao_id)`
  — 1 linha = 1 ligação real (eventos do CDR agrupados por ID, `max()` da
  duração). `duracao_seg` é a duração **bruta** do arquivo (toque + conversa);
  os sinais (`tem_evento_atendida`, `evento_falha`, `atendida_em`,
  `encerrada_em`) ficam persistidos e `atendida`/`tempo_toque_seg`/
  `tempo_conversa_seg` são derivados deles — regra recalculável por SQL, sem
  reimportar.
- `oportunidades(id, numero UNIQUE "2026/00583", conta, cnpj_cpf, solucao, titulo, contato, vendedor, pessoa_id, tipo_cliente, fase_atual, status, motivo_conclusao, fase_01..06_em, produtos/servicos/recorrencia/ticket_centavos, meses, temperatura, origem, vertical, telefone, celular_1/2, email, incluido/atualizado_em, extras_json, importacao_id)`
  — modelo do Omie. `fase_atual` (01_Lead novo, 02_Qualificação, 03_Negociação,
  06_Conclusão) e `status` (Ativo, Perdido, Conquistado) são **dimensões
  independentes**; `fase_NN_em` guarda a data de entrada em cada fase (as fases
  04/05 vêm nas colunas sem nome "Data de -"/"Data de --"); telefones só
  dígitos (futura chave de cruzamento com matrículas); dinheiro em centavos.
- `oportunidade_mudancas(id, oportunidade_id, campo fase_atual|status|motivo_conclusao|ticket_centavos, valor_anterior, valor_novo, observado_em, importacao_id)`
  — histórico de mudanças entre importações ("ficou N dias em Qualificação").
- `turmas(id = classes.id, nome = title, subtitulo = subtitle, start_date, end_date, sincronizado_em)` e
  `matriculas(id = enrollments.id, turma_id, student_id, aluno_* normalizados, wallet, pessoa_id, status, valor_centavos, oportunidade_id, match_metodo, match_confianca, criada_em, sincronizado_em)`
  — cópia local do MySQL por **upsert incremental** (`enrollments.updated_at`
  desde o último sync, margem de 3 dias; primeiro sync completo; nunca DELETE).
  `status = 'canceled'` **não conta como receita**; matrícula com aluno órfão na
  origem é mantida com dados em branco (nunca descartada em silêncio).
- `metas(id, pessoa_id NULL=todos, indicador ligacoes_dia|leads_dia|matriculas_dia|receita_mes, valor, vigente_desde/ate)`
  — seed: 45 ligações/dia, 14 leads/dia, 1.3 matrículas/dia e **receita_mes =
  7.500.000 centavos (R$ 75.000/mês por consultor)**, todos vigentes desde
  2026-01-01; override por pessoa via `pessoa_id`.
- `periodos(id, nome, data_inicio, data_fim)` — períodos de relatório (Etapa 2).

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
| `POST /api/importacoes/cdr?arquivo=` | upload do CSV como corpo text/plain (25 MB); resposta traz o relatório completo (ignoradas com motivo, ressalvas, avisos); erro estrutural → 422 |
| `POST /api/importacoes/oportunidades?arquivo=` | upload do .xlsx do Omie como corpo binário (`application/octet-stream`, 25 MB); resposta traz novos/atualizados/idênticos + período coberto (min/max de "Data de Inclusão"); erro estrutural → 422 |
| `GET /api/importacoes` e `/:id` | auditoria das ingestões (últimas 50 / detalhes) |
| `POST /api/sincronizacoes/mysql` | sync incremental da Unyflex + cruzamento matrícula↔oportunidade; 503 sem MYSQL_* no .env |
| `GET /api/metricas?de=&ate=` | cálculo ao vivo do motor de métricas (preview) |
| `GET/POST /api/periodos`, `GET/DELETE /api/periodos/:id`, `POST /:id/recongelar` | períodos congelados: criar congela na hora (snapshot v1); recongelar grava NOVA versão (as antigas ficam — trilha auditável); `?versao=` consulta versão antiga |
| `GET /api/saude` | saúde dos dados (frescor por fonte, matches quebrados, furos de cruzamento) |
| `GET /tv?token=`, `GET /api/tv/dados?token=` e `GET /api/tv/eventos?token=` (SSE) | painel de TV: **fora do auth de sessão**, token de dispositivo `TV_TOKEN` do .env comparado com `timingSafeEqual`; sem a variável → 503. Payload: dia parcial com ritmo projetado (jornada 09–18, pela hora do último dado), semana × dias úteis decorridos, receita mensal × R$ 75k e frescor por fonte. O SSE emite `{tipo:"dados", fonte}` ao fim de cada ingestão (heartbeat a cada 25 s); o cliente refaz o fetch e decide o que animar/celebrar por diff. Parâmetros: `?giro=N` (segundos por visão, padrão 20), `?fixo=dia\|semana\|mes`, `?dia=sempre` (mostra HOJE mesmo sem CDR do dia), `?som=0`, `?volume=0–1` |
| `GET /api/sincronizacoes/status` | MySQL configurado?, última sync, contagens locais |

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
- **Ingestão idempotente com auditoria**: dedupe por upsert na chave natural
  (`ligacoes.cdr_id`, `oportunidades.numero`) — reimportar nunca duplica; linha
  idêntica ao banco não sofre UPDATE (contador `registros_identicos` nos dois
  importadores); hash repetido gera aviso. Linha ruim nunca aborta a importação:
  vira motivo/ressalva no relatório (`detalhes_json`). Armadilhas do CDR
  tratadas: eventos agrupados por ID com `max()` da duração, linhas sem ID
  descartadas, **ID validado contra o padrão real `/^\d+\.\d+$/`** (epoch.seq —
  descarta rodapés "TOTAL: N"/"DURAÇÃO: HH:MM:SS" com motivo `id_invalido`, sem
  blacklist de rótulos), regex tolerante `/(\d{1,2}):(\d{2}):(\d{2})/`, BOM
  utf-8-sig.
- **Atendida é derivada de sinais, não da duração** (decisão do usuário,
  2026-08-18): o CSV do CDR vem em "retratos repetidos" — a linha com ID
  reaparece várias vezes (só a última traz a duração total) e as linhas **sem
  ID são eventos da mesma ligação** (Atendida, Encerrada, Ocupado…),
  associadas por posição ao último ID válido. A DURAÇÃO bruta **inclui o tempo
  de toque** (Ocupado/Não atendeu saem com duração > 0), então:
  `atendida = tem_evento_atendida` (o grupo contém o evento "Atendida").
  Três buckets distinguíveis por SQL: atendida (`atendida = 1`), falha
  explícita (`atendida = 0 AND evento_falha IS NOT NULL` — Ocupado, Não
  atendeu, Rejeitada, Destino Desconectado) e "só Encerrada"
  (`atendida = 0 AND evento_falha IS NULL` — chamou e desligaram antes de
  atender; classificado como NÃO atendida, mas operacionalmente distinto).
  **TMA usa sempre `tempo_conversa_seg`** (atendida_em → encerrada_em), nunca
  `duracao_seg` — a duração bruta infla o TMA com o tempo de toque. Mudança de
  regra futura = UPDATE por SQL sobre os sinais persistidos, sem reimportar.
  ⚠ Relatórios gerados antes desta correção usavam `atendida = duração > 0`
  (~98% de taxa aparente vs ~59% real) e **não são comparáveis**.
- **Omie: retrato ∪ histórico**: cada exportação cobre só uma janela recente, o
  banco é a **união** de todas — o upsert por "Número" insere/atualiza e **nunca
  apaga** o que não veio no arquivo. Linha idêntica ao banco não sofre UPDATE
  (contada em `registros_identicos`); mudança em fase/status/motivo/ticket vai
  para `oportunidade_mudancas` (de → para); `fase_NN_em` usa COALESCE no UPDATE
  (data de fase conhecida nunca regride a NULL). Armadilhas tratadas: cabeçalho
  na linha 2 (procurado nas 5 primeiras), **"N/D" = NULL** em qualquer coluna,
  colunas sem nome "Data de -"/"Data de --" = fases 04/05, datas do exceljs
  lidas com getters UTC (dia literal da planilha, sem deslocar fuso), dinheiro
  inteiro em reais → centavos, vendedor casado por `pessoas.nomes_alternativos`
  (sem match = ressalva no relatório, nunca palpite por primeiro nome), colunas
  não mapeadas preservadas em `extras_json`.
- **Ressalva conhecida (Omie)**: a exportação parece reter só uma janela recente
  (leads por dia crescem monotonicamente até o último dia do arquivo — artefato,
  não aceleração real). A contagem de leads novos por dia só é confiável para os
  dias finais de cada arquivo. Cada importação compara a **sobreposição** com o
  banco e avisa quantas oportunidades sumiram do retrato (e quantas dentro do
  período coberto) — é o que prova ou derruba a hipótese a cada novo arquivo.
- **MySQL nunca ao vivo**: relatórios leem só a cópia local (`turmas`/`matriculas`),
  atualizada por sync incremental transacional — mesmos números para o mesmo
  período e zero carga na produção. Usuário exclusivo somente-SELECT **apenas em
  classes, enrollments e students** (qualquer query em outra tabela: avisar o
  usuário, não assumir permissão). Esquema real confirmado: curso é
  `classes.title`/`subtitle` (não "name"); cancelamento é
  `enrollments.status = 'canceled'` (sem `deleted_at`). Timeout de 10s na
  conexão e 30s por query — falha explícita na tela, nunca trava o app.
- **Cruzamento matrícula ↔ vendedor/oportunidade** (roda ao fim de cada sync,
  só no SQLite): (a) direta — `wallet` → `pessoas` por nome normalizado exato
  contra `nome` + `nomes_alternativos` (formatos reais do wallet incluídos na
  migração 7; sem match = listado no relatório, ex.: "Unyflex", ex-vendedores);
  (b) por contato — e-mail exato em minúsculas (confiança alta), telefone pelos
  últimos 9 dígitos (média) ou 8 (baixa), gravado em
  `oportunidade_id`/`match_metodo`/`match_confianca`. Matrícula sem match
  NUNCA é descartada (pode ser venda fora do CRM). Relação
  oportunidade→matrículas é **1:N** (uma venda B2G vira várias matrículas).
  Empate entre oportunidades candidatas: prefere Conquistada, depois a mais
  recente.
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

### ✅ Etapa 1 (central de dados) — Ingestão e modelo canônico (concluída)
- Migração 4: `pessoas` (ramal + crm_user_id + wallet unificados), `ligacoes`,
  `oportunidades`, `turmas`, `matriculas`, `metas`, `periodos`, `importacoes`
- Importadores idempotentes com relatório e auditoria; CDR (CSV) e oportunidades
- Sincronização snapshot do MySQL Unyflex (somente leitura, cópia local)
- Tela `/central` (uploads, sync, histórico de ingestões)
- Migração 5: fonte de oportunidades trocada do Ramper para o **Omie** (.xlsx) —
  modelo fase × status, datas de entrada por fase, `oportunidade_mudancas`,
  `pessoas.nomes_alternativos`, contador de idênticos na auditoria

### ✅ Etapa 2 (central de dados) — Motor de métricas (concluída)
- `metricas.js`: motor **em SQL puro — nenhum número sai de modelo de linguagem**;
  denominador = **dias úteis** (seg–sex, sem feriados — limitação conhecida);
  discadas (meta 45/dia, inclui "só Encerrada") ≠ atendidas (qualidade);
  **TMA = tempo_conversa_seg, nunca duração bruta**; leads (meta 14/dia) por
  `fase_01_em`; perdidas por `COALESCE(fase_06_em, atualizado_em)` (flag de
  aproximação); **matrículas (meta 1,3/dia, conta alunos) ≠ vendas
  (conquistadas) ≠ receita — sempre as três lado a lado**; conflito de
  atribuição: vale o wallet, contado e exposto; canais (Unyflex) e sem
  atribuição fecham os totais da empresa fora de ranking/metas/feedback.
  Migração 9 retroagiu as metas padrão para 2026-01-01.
- Períodos congelados com versões (`periodo_snapshots`) — tela `/relatorios`
- Tela `/saude` (frescor, wallets/vendedores sem match, matrículas sem
  oportunidade, conquistadas sem matrícula, conflitos, alunos órfãos)
- Painel de TV 2.0 `/tv?token=` — **rotação automática** entre três visões
  (crossfade + indicador): **HOJE** (barras discadas × meta com ritmo projetado
  pela hora do último dado do CDR, jornada 09:00–18:00; a visão **sai da
  rotação** quando não há CDR do dia — `?dia=sempre` força com selo), **SEMANA**
  (barras × meta escalada, selo ✓ ao cruzar meta, pódios visuais de
  ligações/leads/receita) e **MÊS** (a mais espaçosa: barras grandes de receita
  × R$ 75.000). **Tempo real por SSE**: ingestão concluída → evento → refetch;
  polling de 60 s como rede de segurança; diff no cliente anima contagem, dá
  glow em quem mudou/cruzou meta e dispara **celebração de matrícula nova**
  (overlay ~5 s com nome + valor, confete e som próprio). Som via WebAudio
  sintetizado, **desbloqueado por um toque** (overlay inicial; indicador 🔔/🔕)
  — única interação permitida na tela. `pessoas.entra_painel = 0` (Renato) fica
  fora de dia/semana/rankings; a receita dele aparece só na visão do mês.
  "Sem dados" (tudo zero) é neutro cinza — vermelho só para atrasado com dado
  real. **Decisão revogada em 2026-08-18**: receita por consultor e ranking de
  receita APARECEM na TV; continua fora qualquer texto avaliativo sobre pessoas
  — só número, tudo do motor SQL, zero IA
- Validado contra a conferência da semana 10–14/08 (1.225+1 discadas, 723
  atendidas, taxas por consultor, 176 leads na janela, 4 vendas)

### Etapa 3 (central de dados) — IA sobre as métricas (próxima)
- Relatório de feedback individual (respeitando `entra_feedback`; Renato fora)
- Camada de IA consumindo as métricas prontas do motor — nunca gerando números

### Etapa 4 — Ideias futuras (a priorizar)
- Multiusuário completo (cadastro/gestão de usuários — a base já existe na Etapa 0)
- Glossário automático de termos-chave
- Compartilhamento de resumo por link público somente leitura
- Seleção de idioma / tamanho de bloco pela interface
- Streaming do resumo para aulas longas
