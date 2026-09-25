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
├── metas.html       # painel de metas            (rota /metas)
├── territorio.html  # inteligência por território (rota /territorio)
├── metricas.js      # motor de métricas em SQL puro + saúde + payload TV
├── feedback.js      # Etapa 3: dossiê de fatos + prompt do feedback individual (IA)
├── territorio.js    # território: referência PR/SC, casamento cidade→município, cobertura
├── prospeccao.js    # prospecção ativa: importação, tela de trabalho, carteiras, gerencial
├── cruzamento.js    # Fase 4: CDR × prospecção/Omie/matrículas (classe por ligação, painéis)
├── prospeccao.html  # prospecção: Trabalho / Gerencial / Cores e status / Cobertura (rota /prospeccao)
├── escopo.js        # papéis (admin | vendedor) e escopo por regional — corte no servidor
├── usuarios.html    # usuários e carteiras (rota /usuarios, admin)
├── trocar-senha.html # troca de senha (obrigatória no 1º acesso)
├── meu-painel.html  # painel do vendedor: métricas próprias × metas
├── js/nav.js        # menu por papel via /api/sessao (conveniência; a proteção é nas rotas)
├── dados/           # referência versionada (CSV de regionais, JSONs do IBGE, mapa SVG)
├── scripts/gerar-referencias-territorio.js  # regenera dados/ a partir do IBGE (precisa de internet)
├── scripts/banco.js # manutenção do SQLite: conferir | checkpoint | backup (deploy seguro)
├── DEPLOY.md        # procedimento de deploy em produção (Docker) e migração do banco p/ o volume
├── .dockerignore    # a imagem NUNCA leva banco (*.db, -wal, -shm), backups/, data/, planilhas, .env nem node_modules
├── Dockerfile       # 2 estágios: npm ci --omit=dev com toolchain → node:22-bookworm-slim
├── docker-compose.yml # serviço jonias: DB_PATH, NODE_ENV, env_file, volume ./data (Traefik no override, fora do git)
├── css/style.css    # tema dark completo (robô, listas, modais, login, view, central)
├── js/
│   ├── markdown.js  # conversor MD→HTML compartilhado (navegador + servidor/PDF)
│   ├── app.js       # sessão ao vivo (SpeechRecognition, blocos, encerramento)
│   ├── aulas.js     # lista, busca, criar/renomear/excluir
│   ├── aula-view.js # visualização + links de exportação
│   ├── central.js   # uploads, sincronização e histórico de ingestões
│   ├── territorio.js # cobertura do casamento + revisão manual (Fase 1)
│   └── login.js
├── aula-ai.db       # SQLite local (gerado em runtime, ignorado no git; produção: DB_PATH no volume)
└── .env             # ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_*, MYSQL_*, TV_TOKEN, DB_PATH
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

**Caminho do banco (`DB_PATH`)**: sem a variável, o banco é `./aula-ai.db` na
raiz (desenvolvimento). Com ela, é o arquivo indicado — em produção
`DB_PATH=/app/data/aula-ai.db`, dentro do diretório montado como volume
(`./data:/app/data`; diretório, nunca bind de arquivo único, porque `-wal` e
`-shm` ficam ao lado do `.db`). O boot **falha alto** (sai sem criar nada)
se `DB_PATH` aponta para diretório inexistente/não gravável ou para arquivo
que não existe (`DB_CRIAR_NOVO=1` libera criar um banco novo de propósito), e
se `NODE_ENV=production` estiver sem `DB_PATH`. Todo boot loga
`🗄 Banco: <caminho absoluto> (DB_PATH|padrão local) · user_version N · N
contato(s) de prospecção` — a primeira coisa a conferir depois de um deploy.

Abrir `http://localhost:8000` no Chrome → redireciona para /login.
**Modo de teste:** `?bloco=30` na URL da sessão ao vivo reduz o bloco de 400
para 30 palavras.

## Deploy seguro (produção)

Procedimento completo, passo a passo, em **`DEPLOY.md`** (inclui a migração
única do banco de `/app/aula-ai.db` para o volume). O incidente que motivou
(2026-09-22): o app gravava em `/app/aula-ai.db`, fora do volume, e cada
`docker compose build` + `up` recriava o container com o banco da imagem —
dados da equipe perdidos. A causa era o `COPY . .` do Dockerfile do servidor
sem `.dockerignore`, que empacotava o `aula-ai.db` local na imagem.
**`Dockerfile` e `docker-compose.yml` são versionados desde 2026-09-23.** O
Dockerfile tem dois estágios, com `npm ci --omit=dev` num estágio que tem
python3/make/g++: `better-sqlite3` compila quando não há binário pronto para
a versão do Node, e a falta desse estágio foi medida no build. O compose traz
`DB_PATH`, `NODE_ENV=production`, `env_file: .env`, `init: true` e
`./data:/app/data`. Labels, rede e domínio do Traefik ficam em
`docker-compose.override.yml`, só no servidor e no `.gitignore`, com modelo em
`docker-compose.override.example.yml`. O nome do serviço (`jonias`) tem de ser
igual ao do container que já roda. O `.dockerignore` barra também
`node_modules/` e `.env`, que entra só pelo `env_file`. Regras:

- **Backup antes de todo deploy**: `node scripts/banco.js backup
  /app/data/aula-ai.db /app/data/backup-<data>.db` (API de backup online do
  SQLite: consistente com o app rodando, arquivo único) + `conferir` para o
  retrato "antes"; copiar backups para fora do servidor.
- **Nunca copiar o banco local por cima do de produção** (bases diferentes; a
  de produção tem o trabalho da equipe) e nunca empacotar banco na imagem
  (`.dockerignore` com `**/*.db` — sem `**/` só casa na raiz do contexto).
- **Conferir depois de subir**: a linha `🗄 Banco:` do log tem de dizer
  `/app/data/aula-ai.db (DB_PATH)` com a contagem de contatos esperada;
  `scripts/banco.js conferir` mostra user_version, quick_check, contagens das
  tabelas de trabalho, carimbos mais recentes e as últimas importações
  recusadas com o motivo. Comparar com o "antes".
- `stop` preserva o container (e o banco dentro dele); `down`/`up` com imagem
  nova destroem. `scripts/banco.js` roda em imagem que ainda não o tem:
  `docker compose exec -T <serviço> node - conferir <db> < scripts/banco.js`.

## Banco de dados

Esquema versionado por `PRAGMA user_version` (migrações em `db.js`, uma transação
por versão; a migração 1 é o baseline idempotente — bancos novos e antigos passam
pelo mesmo caminho). Versão atual: **25**. Migração que recria tabela referenciada
por outras (`importacoes`, na 20) é marcada com `desligarFk`: o runner desliga
`foreign_keys` fora da transação, confere `foreign_key_check` ao fim e religa.

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
  6 originais + **Eduardo (migração 17, 2026-09-04)** — "Andrey Eduardo Dudek"
  no wallet/Vendedor, exibido como Eduardo, ramal 2001, flags 1/1/1, metas
  padrão (`crm_user_id` do Eduardo e do Frederico pendentes; **Renato voltou a
  rankings, metas e feedback na migração 14** — flags 1/1/1). ⚠ **Ramal 2001 consolidado no Eduardo SEM vigência
  (2026-09-04)**: o ramal era do Hirlan (que ficou sem ramal e segue em
  `OCULTOS_TEMPORARIOS_TV`); a migração 17 reatribuiu TODO o histórico de
  `ligacoes.ramal = '2001'` ao Eduardo, inclusive as ligações de agosto que
  apareciam como do Hirlan (250 no banco local; o número de produção sai no log
  do deploy). Relatórios/snapshots congelados antes dessa data guardam essas
  ligações no Hirlan e **não batem** com um recálculo — terceira quebra de
  comparabilidade, ao lado da taxa de atendimento e das turmas `unyflex = 1`.
  `tipo`: consultor | canal;
  `entra_painel` controla as visões de prospecção da TV (dia/semana/rankings);
  `entra_tv = 0` oculta de TODAS as visões da TV, mês incluído. As duas flags
  são só da TV — relatórios internos ignoram. Canais: **Unyflex** (balcão) e
  **Gerencial** (migração 14; wallet `Gerencial` + qualquer wallet contendo
  "gere", regra explícita em `resolverWallet`; oportunidades do Omie com
  vendedor Paulo/Gustavo via `nomes_alternativos` = Paulo, Gustavo, Paulo
  Orfanelli). Canal nunca entra em ranking de ligações/leads, metas ou
  feedback; Gerencial aparece na TV só em receita (cartão no MÊS + pódio de
  receita da semana) e conta para a meta da equipe se
  `meta_equipe_inclui_gerencial = '1'`.
- `configuracoes(chave PK, valor)` — chave→valor global; `tv_som` ('0'/'1',
  nasce '0': silêncio é o padrão da TV), alterada pelo toggle da /central via
  `GET/PUT /api/config/tv`; `tv_ocultos_aplicados` (JSON) é escrita pelo
  reforço de ocultação no boot (ver abaixo), não editar à mão;
  `meta_equipe_inclui_gerencial` ('0'/'1', nasce '0') — toggle na /metas via
  `PUT /api/metas/config`.
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
- `turmas(id = classes.id, nome = title, subtitulo = subtitle, start_date, end_date, unyflex, sincronizado_em)` e
  `matriculas(id = enrollments.id, turma_id, student_id, aluno_* normalizados, wallet, pessoa_id, status, valor_centavos, oportunidade_id, match_metodo, match_confianca, criada_em, sincronizado_em)`
  — cópia local do MySQL por **upsert incremental** (`enrollments.updated_at`
  desde o último sync, margem de 3 dias; primeiro sync completo; nunca DELETE;
  **turma que ainda não existe na cópia local recebe todas as matrículas,
  sem corte incremental** — é assim que uma mudança de filtro traz histórico
  sem recriar o banco). `turmas.unyflex` (migração 15) é a flag da origem,
  para separar por SQL a receita das turmas `unyflex = 1`.
  `status = 'canceled'` **não conta como receita**; matrícula com aluno órfão na
  origem é mantida com dados em branco (nunca descartada em silêncio).
- `metas(id, pessoa_id NULL=padrão, indicador, valor, vigente_desde/ate)` —
  indicadores (CHECK, migração 16): diários `ligacoes_dia|leads_dia|
  matriculas_dia|receita_dia` (mandam em HOJE/SEMANA da TV e nos relatórios,
  × dias úteis), **semanal `receita_semana`** (por vendedor, número próprio —
  não é receita_dia × 5; visão RECEITA DA SEMANA da TV, escopo `semana` em
  `/metas`), mensais `ligacoes_mes|leads_mes|matriculas_mes|receita_mes`
  (visão MÊS da TV) e da EQUIPE `receita_semana_equipe|receita_mes_equipe`
  (sempre `pessoa_id NULL`; alvo próprio, **não** a soma das individuais).
  Receita sempre em centavos. Seed: 45/14/1,3 por dia e receita_mes =
  7.500.000 (R$ 75.000/mês por consultor) desde 2026-01-01, receita_semana =
  2.000.000 (R$ 20.000/semana) desde 2026-09-04; os demais nascem vazios e
  são definidos no painel `/metas`. ⚠ **Inconsistência conhecida e
  deliberadamente não corrigida (2026-09-04)**: R$ 20.000/semana × 52 ÷ 12 ≈
  R$ 86.667/mês, acima da meta mensal de R$ 75.000 — `/metas` mostra essa
  projeção ao lado do campo (célula e modal, ao vivo); a decisão é do usuário.
  `pessoa_id NULL` = padrão herdado por quem não tem meta própria. **Vigência**: editar cria linha nova a partir
  da data escolhida e fecha a aberta anterior em `vigente_ate = data − 1`
  (`gravarMetas` em `metricas.js`); nada é apagado (exceção: linha da MESMA
  data é corrigida/removida — nunca valeu para dia anterior); data anterior à
  última vigência → 400. `metasVigentes(de, ate)` é intersecção (a de
  `vigente_desde` mais recente vence o período inteiro — sem rateio quando a
  meta troca no meio do período; limitação documentada).
- `periodos(id, nome, data_inicio, data_fim)` — períodos de relatório (Etapa 2).
- `feedbacks(id, periodo_id, snapshot_id, pessoa_id, modelo, fatos_json, texto_md, criado_em, usuario_id)`
  — feedbacks individuais gerados por IA (migração 13). `fatos_json` guarda o
  dossiê EXATO enviado ao modelo (texto sempre auditável contra números
  congelados); gerar de novo insere nova linha — versões antigas ficam.

Território (migração 18, 2026-09-09; módulo `territorio.js`; **zero IA**):

- `regionais(id, uf, sigla, nome, cidade_polo, UNIQUE(uf, sigla))`,
  `municipios(codigo_ibge PK, uf, nome, nome_normalizado, regional_principal_id → regionais)`,
  `regional_municipios(regional_id, codigo_ibge, ordem)` — referência de PR/SC
  carregada em **todo boot** por `carregarReferencias()` (idempotente) a partir
  de `dados/municipios_ibge_PR_SC.json` (694 municípios com código IBGE) e
  `dados/regionais_municipios_PR_SC.csv` (CSV do usuário: `uf;sigla_regional;
  nome_regional;cidade_polo;municipio`, BOM + `;`; 40 regionais, 714 vínculos).
  **20 municípios do PR estão em duas regionais**: `regional_municipios` guarda
  todos os vínculos e `regional_principal_id` elege a que conta (decisão do
  usuário, 2026-09-09: mapa do estado e totais usam só a principal, então
  regionais somam igual ao estado; a outra regional mostra o município como
  "compartilhado", à parte). Padrão da principal = primeira ocorrência no CSV;
  alterável em `/territorio` e preservada nos boots seguintes. Município do
  CSV inexistente no IBGE → **erro fatal no boot**; CSV ausente → aviso alto,
  app sobe sem regionais. Vínculo que sumiu do CSV é removido (é referência).
- `municipio_apelidos(id, cidade_norm, uf_norm, resultado municipio|fora|ignorar|pendente, codigo_ibge, metodo, confianca, distancia, amostra_original, criado_em, usuario_id, UNIQUE(cidade_norm, uf_norm))`
  — 1 linha por chave (cidade normalizada, UF normalizada). Resultado
  automático **nunca é sobrescrito** (estável entre syncs); resolução manual
  (`metodo = 'manual'`) substitui e nunca é perguntada de novo.
- `matriculas` ganhou `aluno_estado` (students.state, trim), `aluno_cep` (só
  dígitos), `codigo_ibge`, `municipio_metodo`, `municipio_confianca`. A
  migração marca `configuracoes.sync_completo_pendente = '1'`: o sync
  seguinte ignora o corte incremental e reprocessa tudo (as antigas não
  passariam pelo `updated_at`); a marca é apagada ao concluir.
- **Casamento cidade → município** (`cruzarMunicipios()`, ao fim de cada sync
  e após cada resolução manual; 6 k linhas, ~50 ms): `normalizarCidade`
  desfaz mojibake (latin1→utf8), extrai sufixo de UF ("Toledo - PR",
  "Curitiba (Paraná)" — hífen colado como "Ji-Paraná" é nome), tira acento/
  pontuação/caixa e aplica `d + vogal → do` ("D'Oeste", "D IGUAÇU");
  `normalizarUf` aceita sigla, nome por extenso, sigla embutida e, sem state,
  a **faixa de CEP** (80000–87999 = PR, 88000–89999 = SC, resto = OUTRA).
  Camadas, na ordem: `exato_uf` (nome + UF, alta) → `exato` (nome único em
  PR+SC sem UF, alta) → `fora_uf`/`fora_cep`/`fora_brasil` (média; o último
  usa `dados/municipios_brasil.json`) → `aproximado` (Levenshtein ≤ min(2,
  20% do tamanho), candidato único, média) → `pendente` (`sem_uf` = homônimo
  PR/SC sem UF, `conflito_uf` = "Concórdia/PR", `sem_match`). Nunca palpite.
  Na matrícula, resolução manual grava `manual` | `manual_fora` |
  `manual_ignorar` em `municipio_metodo`. Medido em 2026-09-09 (5.784
  matrículas válidas): 90,5% casadas / 92,2% da receita; 5,2% fora de PR/SC
  (7,5% da receita); 11 chaves pendentes (R$ 16 k).
- "Período inteiro" em `/territorio` exclui matrículas com `criada_em NULL`
  (44 na base, R$ 2.690) — elas nunca entram em período nenhum dos
  relatórios; a tela mostra a contagem à parte (`semData`).
- **Migração 19 (2026-09-09)**: `matriculas.aluno_uf` = UF resolvida (state,
  sufixo da cidade ou faixa de CEP — agora com a tabela de faixas de **todas**
  as UFs, então `fora_cep` sabe o estado) e, para município casado, a UF do
  município; é o que permite "Outros estados" por UF em SQL. Marca
  `configuracoes.territorio_recruzar_pendente = '1'`: o boot reprocessa o
  casamento uma vez (`recruzarSePendente()`) e apaga a marca. Apelido
  automático cuja chave sumiu das matrículas é removido no cruzamento (o
  manual fica).
- **Revisão em lote**: `pendencias()` devolve, por chave, amostras da cidade,
  estado e CEP como vieram, e uma `sugestao` heurística com motivo (campos
  cidade/estado trocados, homônimo em outra UF, município contido no texto,
  prefixo único, ≤ 2 letras em nome ≥ 6, vários CEPs de cidades diferentes →
  ignorar, texto ≤ 4 letras → ignorar, cidade que existe em outra UF → fora).
  A tela pré-preenche e o usuário confirma em lote (`POST
  /api/territorio/apelidos/lote`, valida tudo antes de gravar, reprocessa uma
  vez). O botão CEP consulta ViaCEP/BrasilAPI **pelo navegador do revisor** —
  o servidor nunca acessa a internet.
- **Agregação (`agregarTerritorio(de, ate)`)**: municípios (os 694, com zero
  e `temHistorico`), regionais **só pela principal** (compartilhados à parte,
  com `contadoEm`), estados, `outrosEstados` por UF, `semMunicipio` por grupo,
  total e `conferencia` com 4 elos (municípios = regionais [+ sem regional] =
  estados; estados + outros + sem município = total; total =
  `calcularMetricas().empresa` — sem período, a janela é min/max de
  `criada_em`). A tela mostra ✓/✗ com os dois lados e a diferença; **nunca
  ajusta**. Conferido em 2026-09-09: fecha na base inteira (5.740 / R$
  9.392.004,50) e em ago/26 (177 / R$ 237.542). Alunos distintos =
  `COUNT(DISTINCT COALESCE(student_id, 'm'||id))` (não aditivo: SQL próprio
  por regional/estado). `detalheMunicipio` traz resumo (matrículas, alunos,
  receita, ticket, canceladas), cursos (por `turmas.nome`), carteira por
  vendedor e a lista de alunos — sempre da cópia local.

Prospecção ativa (migração 20, 2026-09-09; módulo `prospeccao.js`; **zero IA**).
Decisão: o jonIAs é o lugar OFICIAL das carteiras de prospecção (o Excel será
abandonado). Fase 1 = carga com fidelidade total:

- `contatos_ativo(id, uf, setor, linha_origem, arquivo_nome, importacao_id, orgao, municipio_texto, codigo_ibge, municipio_metodo, municipio_confianca, telefone_original, telefone, telefone_valido, whatsapp_original, whatsapp, responsavel, cargo, email, data_ultimo_contato, observacoes, consultor_planilha, cor_linha → cores_prospeccao, cores_celulas_json, linha_oculta, extras_json, criado_em, atualizado_em, editado_em, UNIQUE(uf, setor, linha_origem))`
  — 1 linha por linha da planilha; `setor` = nome da aba verbatim; `uf`
  escolhida no upload (nunca deduzida do nome do arquivo); `orgao` derivado
  do nome da aba (PM/CM/Autarquia). Reimportar = upsert pela chave natural;
  **aba com `editado_em` preenchido (edição no jonIAs, Fase 2) é recusada**
  na reimportação — o sistema virou a fonte. A recusa é **por aba**: as
  outras abas do arquivo entram normalmente e o relatório traz `resumoAbas`
  (importadas / recusadas por edição / outras) e `bloqueios` — por aba
  recusada, a **prévia do que se perderia** (`previaSobrescrita`: linha,
  campo, valor atual com quem/quando editou, valor da planilha; contatos
  manuais, linhas editadas que sumiram da planilha, histórico e marcações são
  mantidos e contados à parte). **Só admin** pode "sobrescrever mesmo assim"
  (2026-09-22): o reenvio leva `?sobrescrever={aba: assinatura}`; a
  assinatura (nº de linhas editadas + última `editado_em`) amarra a
  confirmação à prévia vista — edição feita depois da prévia faz a aba ser
  recusada de novo, com prévia nova. Na sobrescrita, cada valor trocado vai
  para `contatos_ativo_historico` (valor anterior → planilha, observação
  "sobrescrito pela planilha …") antes do UPDATE; `editado_em` fica (a aba
  continua marcada como trabalhada no sistema). **`pessoa_id` nunca é apagado
  pela reimportação** (`mesclarConsultor`): planilha sem consultor casado
  mantém o atual — a atribuição por carteira não marca `editado_em` e antes
  sumia em silêncio a cada reimportação; com consultor na planilha, a planilha
  vale.
  **Atribuição ao titular na importação** (decisão do usuário, 2026-09-22):
  depois do casamento de município, todo contato das abas importadas que
  ficou sem consultor e cuja regional principal tem titular passa para o
  titular — a mesma regra de `gravarCarteira`, sem marcar `editado_em`;
  histórico `pessoa_id` com observação "atribuído ao titular da regional X na
  importação da planilha … (importação #N)"; contagem por regional em
  `detalhes.atribuidosTitular` e nos avisos. Regional só com apoios não
  atribui; consultor vindo da planilha nunca é trocado. `linha_oculta` marca as linhas
  ocultas da planilha (1.761 PR / 934 SC — importadas, decisão do usuário).
- `cores_prospeccao(cor_hex PK, origem, linhas, celulas, status_nome, significado, ignorar, ordem, atualizado_em, usuario_id)`
  — **cor é informação**: 1 linha por cor de preenchimento distinta (RGB de
  6 hex, tema+tint já resolvidos); `status_nome`/`significado` só o usuário
  dá, em `/prospeccao` (nada é presumido); `ignorar = 1` = só formatação.
  Status do contato = `status_nome` da `cor_linha` (JOIN, nunca copiado).
- **Armadilhas do .xlsx tratadas** (`prospeccao.js`): cabeçalho procurado nas
  5 primeiras linhas e aceito com ≥ 2 colunas do dicionário (aba sem
  cabeçalho fica de fora, listada); mapeamento por nome normalizado +
  sinônimos (`CAMPOS`/`PADROES`: "Reponsavel", "Contato", "Whats"…), **nunca
  por posição**; rótulo genérico ("Coluna 1", "Column 32") é decidido pelo
  CONTEÚDO (`inferirColunasGenericas`: ≥ 80 % dos valores batem com município
  da UF, padrão de telefone ou nome de consultor em `pessoas`; só preenche
  campo vazio; vira ressalva no relatório) — em "PM TRIBUTAÇÃO" (SC) a Coluna
  1 é consultor, em "JURIDICO PM" (SC) é município e a Coluna 2 é telefone;
  "Coluna 1" de "TRIBUTAÇÃO" (PR) não bateu com nada e ficou em extras; coluna
  repetida ou não reconhecida → `extras_json` com o rótulo original e
  contagem no relatório (`colunasNaoReconhecidas`). Telefone: original
  preservado + só dígitos (55/0 iniciais removidos; célula com dois números →
  o 1º vale e os outros vão para extras); célula que o Excel formatou como
  **data** perde o número no exceljs — o valor bruto é lido do XML da aba via
  jszip (`valoresBrutosPorAba`; regex com alternativa `/>` primeiro, senão é
  O(n²)). Cor: `cell.fill` ARGB, tema+tint (tema do arquivo, `_themes.theme1`;
  índices 0 lt1, 1 dk1, 2 lt2, 3 dk2, 4–9 accent; tint na luminância HSL) ou
  indexada; cor da linha = moda das células (empate: coluna município);
  células diferentes → `cores_celulas_json`. Nunca usar `cell.text` (lança em
  célula mesclada). Hiperlinks vão para extras como "(link)".
- Município: `territorio.js` — `chaveDoContato` limpa anotações
  ("APUCARANA (LIGAR APÓS 12H00)", "Campo largo - Consorcio…") antes de
  `classificarCidade`; apelidos compartilhados com as matrículas
  (`municipio_apelidos`), resolvidos na mesma revisão de `/territorio` (que
  mostra "N contato(s) da prospecção" por chave). Medido em 2026-09-09: PR
  16.320 linhas (98,2% casadas), SC 9.680 (96,9%), 34 chaves pendentes —
  quase todas autarquias/entidades no lugar da cidade.
- Auditoria: `importacoes.tipo = 'prospeccao'` com `detalhes_json` completo
  (por aba: colunas casadas, não reconhecidas, telefones, cores, tempos).
- **Migração 21 (2026-09-09, decisão do usuário)**: promovidos de extras a
  campo `curso` (CURSO/Curso/C CURSO — 1.474 linhas), `contato_inexistente`
  (flag 1 quando "contato(s) inexistente(s)"/"tel inexistente" tem qualquer
  texto — "só chama", "telefone não funciona", "Sim"; texto original em
  `contato_inexistente_texto`; **é status, não coluna: prevalece sobre o
  status da cor** na tela de trabalho) e `cadastro_crm` (booleano de
  "Cadastro no CRM?"; Sim/Não → 1/0, outro texto → extras). Aba SAÚDE PM
  (PR) confirmada como esqueleto: só a coluna MUNICIPIO tem valor no XML —
  não é perda de leitura, a planilha nunca teve telefones ali.
- **Migração 22 (Fase 2, 2026-09-09)**: `pessoa_id` (consultor atual — só
  Frederico, Renato, Eduardo, Agnes e Bianca, casados por nome normalizado
  contra nome/wallet/`nomes_alternativos`; "Fred" entrou como grafia do
  Frederico; toda outra grafia fica sem consultor, texto preservado em
  `consultor_planilha`; 15.097 casados), `editado_por`, `origem`
  (`planilha` | `manual`) e `contatos_ativo_historico(contato_id, tipo
  contato|edicao|status|criacao, canal ligacao|whatsapp|email|visita|outro,
  campo, valor_anterior, valor_novo, observacao, usuario_id, registrado_em)`.
  **Status** = `cor_linha` → `cores_prospeccao` (marcar status = trocar a
  cor; status novo = linha com `origem = 'criado'`); status efetivo:
  `contato_inexistente = 1` → "Contato inexistente", senão `status_nome`
  da cor (sem nome/ignorada → sem status). Tela de trabalho em
  `/prospeccao` (aba Trabalho): filtros em memória (busca, município,
  regional, setor, consultor, status múltiplo, ocultas, sem telefone,
  inexistente, nunca tocado, período do último contato — estado no
  `hash`), tabela virtual (34 px por linha, ~60 `<tr>` no DOM, cabeçalho
  sticky, ordenação por coluna), edição inline (Enter/Tab salvam, Esc
  cancela, Tab vai para a próxima célula), menu de status, popover
  "registrar contato" (Ctrl+Enter), gaveta de detalhes + histórico, modal
  de novo contato, exportação .xlsx do filtro ou da UF. Teclado na tabela:
  ↑↓ selecionam, R registra, D abre detalhes, Enter edita, / busca.
- **Migração 23 (Fase 3, 2026-09-09) — papéis e escopo.** `usuarios` ganha
  `pessoa_id` (login ↔ consultor, único), `senha_temporaria` (1 = troca
  obrigatória no 1º acesso), `senha_trocada_em`, `ultimo_acesso_em`; `papel`
  ∈ `admin | vendedor` validado no código (a tabela não tem CHECK — recriar
  exigiria desligar FK de 8 tabelas). `carteiras(regional_id, pessoa_id,
  papel titular|apoio)`: N:N com **no máximo um titular por regional**
  (índice parcial); todos os vinculados veem e editam a regional inteira; ao
  definir o titular, os contatos **sem consultor** da regional passam para
  ele (`gravarCarteira`, histórico `campo pessoa_id`, sem marcar
  `editado_em` — atribuição em massa não é edição e não bloqueia
  reimportação). Decisões do usuário: vários vendedores por regional; o
  vendedor vê toda a regional; sem-consultor viram dele.
  **Escopo no servidor** (`escopo.js`): `escopoDe(usuario)` → `null` para
  admin; para vendedor `{pessoaId, regionais, ufs, municipios (Set de
  códigos com regional principal na carteira), vazio}`. As consultas filtram
  no SQL (`clausulaMunicipios`): `payloadTrabalho` (linhas, regionais,
  municípios, setores, consultores = só ele; **pessoa_id de terceiros vira
  -1 e `consultor_planilha` sai como NULL, no próprio SELECT**),
  `buscarLinha` (linha fora do escopo = 404), `atualizarContato`
  (`pessoa_id` só ele/NULL, município só da regional), `criarContato`,
  `exportarXlsx` (ids ∩ escopo), `historicoDoContato`,
  `calcularMetricas(de, ate, pessoaId)` (`pessoa_id = ?` em todas as
  consultas; devolve só `minha`, sem equipe/canais/empresa),
  `resumoMetasDaPessoa`, `agregarTerritorio(…, escopo)` (só regionais e
  municípios dele; sem estados/outros/total/conferência),
  `detalheMunicipio(…, escopo)` (município fora = null; `vendedores` vira
  "você" × "outros" sem nomes; alunos sem o vendedor de terceiros),
  `listarCoresEnxuto`. Rotas de gestão respondem **403** ao vendedor
  (`PREFIXOS_SO_ADMIN` em `server.js`: importações, sincronizações, config,
  períodos, saúde, usuários, carteiras, cobertura, gerencial, status novo,
  pendências/apelidos do território, escritas em metas/cores/principal) e as
  páginas `/central /relatorios /saude /metas /usuarios` também. Login:
  `session.regenerate` (anti-fixação), resposta `{papel, trocarSenha,
  destino}`; `exigirSenhaTrocada` bloqueia tudo (API 403 / página 302) até
  `POST /api/senha` (mín. 10 caracteres com letras e números, ≠ login,
  argon2id, regenera sessão). Rate limit, argon2 e sessão de 12 h
  inalterados; desativar usuário apaga as sessões dele. Auditado em
  2026-09-09 com um vendedor de teste (AMOP/AMSOP): zero nomes de terceiros
  nos payloads, 404/403 onde previsto. Menu por papel em `js/nav.js`
  (`/api/sessao`; esconde links `.so-admin` — conveniência, não proteção).
- **Migração 24 (Fase 4, 2026-09-10) — CDR × prospecção** (`cruzamento.js`,
  **zero IA, só leitura**). Colunas DERIVADAS em `ligacoes`, recalculáveis:
  `numero_externo` (dígitos sem 0/55 iniciais; saída = `numero_b`, entrada =
  `numero_a`), `classe`, `codigo_ibge`, `contato_id`, `oportunidade_id`,
  `matricula_id`, `cruzamento_metodo` (`exato` | `nono_digito` — única
  variante aceita: celular com/sem o 9), `cruzado_em`. Classe, na ordem:
  `interna` (< 8 dígitos) → `prospeccao` (número em `contatos_ativo` e todos
  os contatos no MESMO município; `contato_id` só quando o número é único —
  **o telefone da prefeitura é compartilhado por dezenas de setores, então o
  elo confiável é ligação → município**) → `ambigua` (número em 2+ municípios:
  **não conta em nenhum, fica listada para revisão** — decisão do usuário; na
  base de ago/26 são 173 ligações/127 números, quase sempre uma linha da
  planilha no município errado, códigos IBGE vizinhos) → `cliente`
  (`matriculas.aluno_telefone`) → `lead` (telefone/celulares do Omie) →
  `desconhecida`. `oportunidade_id`/`matricula_id` são preenchidos sempre que
  batem, mesmo com outra classe. **Decisão do usuário: o cruzamento NUNCA
  altera `data_ultimo_contato` nem o histórico** — o CDR é evidência ao lado
  do registro humano. Roda inteiro ao fim de cada importação do CDR, do Omie,
  da prospecção e do sync da Unyflex (~0,5 s para 1,6 k ligações × 26 k
  contatos); edição de telefone/WhatsApp/município de um contato reprocessa só
  as ligações desses números; a migração marca `configuracoes.
  cdr_cruzar_pendente` e o boot cruza uma vez (`cruzarSePendente`). Medido em
  2026-09-10 (CDR 10–18/08, 1.558 ligações): 1.131 prospecção (72,6%, 537
  municípios distintos), 173 ambíguas, 16 clientes, 24 leads, 204
  desconhecidas (DDDs 42, 14, 41, 47, 18…), 10 internas; 3 ligações "fora da
  carteira" (consultor sem vínculo na regional do município). Escopo: vendedor
  recebe só as regionais dele, só as ligações dele nos totais por classe,
  terceiros como "outros"/"outro consultor"/-1 (no SQL), sem ambíguas/DDD/por
  consultor; `POST …/recruzar` é só admin.
- **Migração 25 (2026-09-16) — marcação pessoal** (pedido do usuário: as cores
  importadas são muitas; o vendedor precisa de um "já liguei" simples).
  `marcacoes_prospeccao(usuario_id, contato_id, cor verde|vermelho,
  marcado_em, PK(usuario_id, contato_id))`: sem marcação = sem linha. **Por
  usuário**: cada um vê só as suas; o admin tem as próprias (separadas) e pode
  VER as de outro usuário, só leitura (seletor "marcações de…"). **Camada
  separada**: não toca `contatos_ativo` (nem `editado_em` — não bloqueia
  reimportação), nem `cor_linha`/status, nem o histórico. Na aba Trabalho:
  coluna ● com dois botões (clicar na mesma cor limpa), linha inteira pintada,
  filtro "marcação: todas | só verdes | só vermelhas | sem marcação" (`marca=`
  no hash), contador 🟢/🔴, teclas `1` verde, `2` vermelho (mesma tecla ou `0`
  limpa). Salvamento otimista: o PUT leva o estado FINAL (idempotente), uma
  requisição por contato em voo e cliques durante o voo reenviam só o último
  estado; falha desfaz a pintura com aviso. Marcar com o filtro ativo não tira a
  linha da tela até o próximo filtro (não embaralha a navegação por ↑↓).

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
| `GET/POST /api/periodos/:id/feedbacks` | feedback individual com IA (Etapa 3): GET lista gerados + consultores elegíveis (`entra_feedback = 1`); POST `{pessoaId}` gera via Claude sobre o **snapshot mais recente** do período e grava em `feedbacks`; pessoa com `entra_feedback = 0` → 403 |
| `GET /tv?token=`, `GET /api/tv/dados?token=` e `GET /api/tv/eventos?token=` (SSE) | painel de TV: **fora do auth de sessão**, token de dispositivo `TV_TOKEN` do .env comparado com `timingSafeEqual`; sem a variável → 503. Payload: dia parcial com ritmo projetado (jornada 09–18, pela hora do último dado), semana × dias úteis decorridos, receita mensal × R$ 75k e frescor por fonte. O SSE emite `{tipo:"dados", fonte}` ao fim de cada ingestão (heartbeat a cada 25 s); o cliente refaz o fetch e decide o que animar/celebrar por diff. Parâmetros: `?giro=N` (segundos por visão, padrão 45), `?fixo=dia\|semana\|receita\|mes\|destaque`, `?dia=sempre` (mostra HOJE mesmo sem CDR do dia), `?som=1\|0` (override por dispositivo da config global `tv_som`; ausente = segue a config), `?volume=0–1`, `?teto=N` (padrão 5 — evento com mais de N matrículas novas de hoje atualiza números sem celebração, com registro no console). O payload de `/api/tv/dados` inclui `som` (preferência global) |
| `GET/PUT /api/config/tv` | preferência global de som das TVs (`configuracoes.tv_som`), autenticada; PUT `{som: true\|false}`, corpo inválido → 400; toggle na /central |
| `GET /api/metas`, `PUT /api/metas`, `PUT /api/metas/config` | painel `/metas` (`resumoMetas()`): padrão vigente, valor efetivo por consultor (própria ou herdada, com "desde" e vigência futura), meta da equipe + soma das individuais, receita do mês com/sem Gerencial, histórico. PUT `{pessoaId: null\|id, escopo: dia\|semana\|mes\|equipe, vigenteDesde, valores: {ligacoes, leads, matriculas, receita \| receita (semana) \| semana, mes}}` — campo ausente não mexe, `null`/"" = sem meta (pessoa: volta a herdar), reais → centavos; data inválida/retroativa, escopo equipe com pessoa, consultor inexistente → 400/404. `/config` `{incluiGerencial: bool}`. Ambos emitem SSE `{tipo:"config"}` — a TV refaz o fetch em silêncio (sem pulso/toast) |
| `GET /api/sincronizacoes/status` | MySQL configurado?, última sync, contagens locais |
| `GET /territorio` | inteligência por território (Fase 1: cobertura do casamento + revisão manual; Fases 2–3: agregação e mapas, pendentes) |
| `GET /api/territorio/cobertura?de&ate` | cobertura do casamento por camada (matrículas, receita, %), `casadas`, `chaves`, `semData`; período opcional (ausente = base inteira, mesmo filtro dos relatórios) |
| `GET /api/territorio/pendencias` | `pendentes` e `aproximados` (chave, amostras como vieram, UF/CEP, matrículas, receita, 3 sugestões por Levenshtein) + `compartilhados` (municípios em duas regionais com opções de principal) |
| `POST /api/territorio/apelidos` | `{cidadeNorm, ufNorm, resultado: municipio\|fora\|ignorar, codigoIbge}` → grava apelido `manual` e reprocessa todas as matrículas; inválido → 400 |
| `GET /api/territorio/municipios` | 694 municípios (+ regionais vinculadas e principal) e 40 regionais |
| `PUT /api/territorio/municipios/:codigo/principal` | `{regionalId}` — só entre as regionais vinculadas ao município no CSV (senão 400) |
| `POST /api/territorio/apelidos/lote` | `{itens: [{cidadeNorm, ufNorm, resultado, codigoIbge}]}` — confirmação em lote da revisão; valida todos antes de gravar, reprocessa uma vez |
| `GET /api/territorio/agregado?de&ate` | Fase 2: `estados`, `regionais` (principal; `compartilhados` à parte), `municipios` (694, com `temHistorico`), `outrosEstados.porUf`, `semMunicipio.porGrupo`, `total`, `conferencia.elos` (✓/✗ com diferença) |
| `GET /api/territorio/municipios/:codigo?de&ate` | detalhe do município: regional principal + outras, `resumo` (matrículas, alunos distintos, receita, ticket médio, canceladas), `cursos`, `vendedores` (carteira), `matriculas` (alunos), `prospeccao` (regional no período com quantos municípios já compraram + `semCompra`; vizinhos geográficos com situação cliente/nunca e valores no período); 404 se não existe |
| `GET /api/territorio/mapa` | malha municipal PR+SC em SVG (`dados/mapa_PR_SC.svg`, autenticada, `Cache-Control` 1 dia); 503 se o arquivo não existe |
| `POST /api/importacoes/prospeccao?arquivo=&uf=[&sobrescrever=]` | planilha de prospecção (.xlsx binário, 50 MB); `uf` obrigatória (400); resposta com relatório por aba (`abas`), `resumoAbas`, `bloqueios` (prévia das abas recusadas por edição), colunas não reconhecidas, cores, municípios; erro estrutural (arquivo ilegível, falha ao gravar) → 422 com o motivo em `erro` (também no log do servidor e em `importacoes.erro`); `sobrescrever={aba: assinatura}` só admin (403), JSON inválido → 400 |
| `GET /prospeccao` | tela: cores encontradas → status (nome/significado/só formatação, salva ao sair do campo) + cobertura da carga por UF/aba + colunas não reconhecidas |
| `GET /api/prospeccao/cores`, `PUT /api/prospeccao/cores/:hex` | cores com contagens, abas e exemplos reais; PUT `{statusNome, significado, ignorar}` (campo ausente não mexe) |
| `GET /api/prospeccao/cobertura` | por UF e por aba: linhas, ocultas, telefone válido, whatsapp, e-mail, município casado/pendente, cores, editadas; colunas não reconhecidas e abas não importadas da última importação de cada UF |
| `GET /api/prospeccao/contatos?uf=` | Fase 2: payload compacto da UF (`campos` + `linhas` como arrays, ~3 MB para 16 k linhas, ~150 ms), `status` (cores nomeadas não ignoradas), `setores`, `regionais`, `municipios`, `consultores` (os 5) — a tela filtra tudo em memória |
| `PATCH /api/prospeccao/contatos/:id` | `{campo: valor}` nos campos editáveis (`responsavel, cargo, email, observacoes, curso, setor, telefone, whatsapp, data_ultimo_contato, cor_linha, pessoa_id, contato_inexistente, cadastro_crm, linha_oculta, codigo_ibge`); valida (400), normaliza telefone, grava `editado_em/editado_por` e histórico por campo; devolve `{linha, alteracoes}` |
| `POST /api/prospeccao/contatos/:id/contatos` | registrar contato `{canal, observacao, statusHex?, data?}` → histórico `contato`, `data_ultimo_contato` (padrão hoje), status opcional; devolve `{linha, historico}` |
| `GET /api/prospeccao/contatos/:id/historico` | histórico cronológico com usuário e nomes de status |
| `POST /api/prospeccao/contatos` | contato manual (`origem = 'manual'`, `linha_origem` negativo sequencial por UF+setor); município por `codigo_ibge` (mesma UF) ou texto (casado como na importação) |
| `POST /api/prospeccao/status` | status novo `{nome, corHex, significado}` → `cores_prospeccao` com `origem = 'criado'` |
| `POST /api/prospeccao/exportar` | `{uf, ids?}` → .xlsx (uma aba por setor, linha pintada com a cor do status, cabeçalho congelado) — rede de segurança; vendedor: ids ∩ escopo |
| `GET /api/sessao` | Fase 3: `{id, login, nome, papel, pessoa, trocarSenha, escopo: {regionais, ufs, municipios, vazio} \| null}` — base do menu por papel |
| `POST /api/senha` | `{senhaAtual, senhaNova}` → 401 senha atual errada (conta no rate limit), 400 fraca; grava argon2id, zera `senha_temporaria`, regenera a sessão |
| `GET/POST /api/usuarios`, `PATCH /api/usuarios/:id`, `POST /api/usuarios/:id/senha-inicial` | admin: lista + consultores; cria (`login` minúsculo, `papel`, `pessoaId` obrigatório para vendedor) com **senha inicial gerada, devolvida uma vez**; PATCH nome/ativo/pessoa/papel (não desativa nem rebaixa a si mesmo; desativar apaga sessões); nova senha inicial |
| `GET /api/carteiras`, `PUT /api/carteiras/:regionalId` | admin: regionais com titular/apoios, contatos e sem consultor; PUT `{titularPessoaId, apoios}` → grava e atribui os sem-consultor ao titular, devolve `{atribuidos}` |
| `GET /api/prospeccao/gerencial` | admin: por regional — titular, apoios, contatos, telefone válido, sem consultor, trabalhados, nunca tocados, inexistentes, último contato, editados; totais por UF e "sem regional" |
| `GET /api/prospeccao/cdr?de&ate` | Fase 4: `total`, `classes` (ligações/atendidas/municípios por classe), `regionais` (ligações, atendidas, municípios ligados × com contatos, nunca ligados, fora da carteira, `porConsultor`); admin ainda `ambiguas` (número, ligações, última, UF, municípios com linhas e ids), `desconhecidasPorDdd`, `semRegional`, `porConsultor`; vendedor ainda `nuncaLigados` (municípios da carteira sem ligação no período). Período inválido → 400 |
| `GET /api/prospeccao/contatos/:id/ligacoes` | ligações do CDR para o número do contato (`doNumero`) e para o município dele (`doMunicipio`, `totalMunicipio`) — data, atendida, tempo de conversa, falha, consultor (vendedor: terceiros = "outro consultor"); fora do escopo → 404 |
| `PUT /api/prospeccao/contatos/:id/marcacao` | marcação pessoal `{cor: "verde"\|"vermelho"\|null}` do usuário da sessão; idempotente; contato fora do escopo → 404, cor inválida → 400. As marcações próprias vêm em `marcacoes` no `GET /api/prospeccao/contatos` (admin também recebe `marcacoesDe`: quem mais marcou na UF) |
| `GET /api/prospeccao/marcacoes?uf=&usuario=` | admin: marcações de outro usuário na UF (só leitura); vendedor → 403 |
| `POST /api/prospeccao/cdr/recruzar` | admin: reclassifica todas as ligações (derivado, idempotente) e devolve as contagens |
| `GET /usuarios`, `GET /trocar-senha`, `GET /meu-painel` | páginas: usuários + carteiras (admin); troca de senha (todos); painel do vendedor (métricas próprias × metas) |

Erros que escapam das rotas passam por um tratador final em `server.js`: corpo
acima do limite → 413 JSON com tamanho e limite; outros 4xx/5xx → JSON com o
motivo (antes o Express devolvia HTML e a tela só dizia "erro N"). Na
`/central`, `chamarApi` mostra `error` ou `erro` do corpo e, para 422 de
importação, renderiza o relatório inteiro.

Todas as rotas `/api/*` (exceto login e logout) e todas as páginas internas exigem
sessão com usuário **ativo** (sessão órfã/inativa é destruída); sem login: API
responde 401, páginas redirecionam para `/login`. A sessão guarda `usuarioId` e
`papel` (não existe mais o booleano `logado`). Os estáticos servidos são apenas
`/css` e `/js` (o `express.static` na raiz foi removido — não expõe
`server.js`/`.env`).

## Decisões de design importantes

- **Widgets nativos em modo escuro (2026-09-10)**: a lista aberta do `<select>`,
  o calendário do `input[type=date]`, a lista do `<datalist>`, o seletor de cor
  e checkbox/rádio são desenhados pelo Chrome e **ignoram o CSS da página**.
  `:root { color-scheme: dark }` em `css/style.css` faz o Chrome desenhá-los
  escuros em todas as telas, e `option`/`optgroup` têm fundo sólido
  (`--fundo-lista`) e cor explícitos. Sem isso, o fundo translúcido do
  `.campo-select` virava branco na lista aberta, com texto claro herdado, e
  ficava ilegível. Checkbox e rádio usam `accent-color: var(--acento-2)`.
  **Tela nova não precisa de nada**: basta usar `style.css`. Não sobrescrever
  `color-scheme` para `light` em nenhum elemento. Conferir sempre com a lista
  ABERTA: o screenshot da aba não captura o popup nativo, só uma captura da
  tela do Windows captura.
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
  **Filtro de curso válido** (`sincronizacao.js`): turmas `id > 1200 AND
  status = 'able'`; matrículas de turma `unyflex = 0` entram todas, de turma
  `unyflex = 1` só com `final_value > 1000` (decisão do usuário, 2026-09-01 —
  o corte exclui minissérie e assinatura de ticket baixo; na origem o maior
  valor abaixo do corte é R$ 998 e o menor acima é R$ 1.068, sem matrícula na
  fronteira). Turma com `unyflex NULL` fica em `turmas` mas sem matrículas.
  ⚠ **Quebra de comparabilidade (2026-09-01)**: até essa data só entravam
  turmas `unyflex = 0`. Relatórios e snapshots congelados antes de 2026-09-01
  **não incluem** as matrículas das turmas `unyflex = 1` e **não são
  comparáveis** com os gerados depois (impacto medido na origem em
  2026-09-01: +9 matrículas/R$ 22.450 em jun/26, +3/R$ 4.968 em jul/26,
  +3/R$ 6.690 em ago/26; recongelar um período recalcula com a regra nova).
  `turmas.unyflex = 1` permite isolar essa receita por SQL.
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
- Migração 15 (2026-09-01): turmas `unyflex = 1` entram com matrículas
  `final_value > 1000`; `turmas.unyflex`; turma nova na cópia local recebe
  histórico completo no sync (quebra de comparabilidade registrada acima)
- Migração 16 (2026-09-04): indicador `receita_semana` (R$ 20.000/semana por
  vendedor) — ver `metas`. Migração 17 (2026-09-04): vendedor Eduardo e ramal
  2001 consolidado nele sem vigência (quebra de comparabilidade em `pessoas`)
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
- Painel de TV 2.0 `/tv?token=` — **rotação automática** entre quatro visões
  (crossfade + indicador; a quarta, **RECEITA DA SEMANA**, entrou em
  2026-09-04 entre SEMANA e MÊS — por vendedor, R$ feito em número grande
  "/ R$ 20.000", barra na largura toda, % e "faltam R$ X"; meta =
  `receita_semana` própria ou padrão; sai da rotação sem meta cadastrada;
  `?fixo=receita`; cruzar a meta entra no mesmo tratamento de celebração das
  metas da semana; `.tv-linhas-compactas` automático com mais de 5 nomes):
  **HOJE** (barras discadas × meta com ritmo projetado
  pela hora do último dado do CDR, jornada 09:00–18:00; comparativo "terça passada: N" por consultor para discadas/leads/matrículas — métrica sem dado no mesmo dia da semana anterior é omitida em silêncio; a visão **sai da
  rotação** quando não há CDR do dia — `?dia=sempre` força com selo), **SEMANA**
  (**meta FECHADA — decisão de 2026-08-19**: 225 ligações, 70 leads e 6,5
  matrículas = metaDia × 5, seja segunda ou sexta; o contexto temporal é o
  "dia N de 5" no título — só a TV usa meta fechada, o motor interno segue
  proporcional; selo ✓ ao cruzar meta, pódios visuais de
  ligações/leads/receita) e **MÊS** (a mais espaçosa: barras grandes de receita
  × R$ 75.000). **Gráficos em SVG puro desenhados no próprio tv.js — sem CDN
  (o container pode não ter internet)**: sparkline de discadas dos últimos 5
  dias úteis ao lado do número no DIA (termina no último dia com dado — nunca
  mostra zero de dado-que-não-chegou como queda); curva acumulada da semana ×
  traçado ideal (45/dia até 225) na SEMANA; funil de oportunidades ATIVAS por
  fase do Omie na visão do DIA; gauges semicirculares de receita × R$ 75k no
  MÊS. Regra: legível a 4 metros — traço grosso, rótulo grande, innerHTML só
  quando o SVG muda (sem flicker). **Celebração em dois níveis**: FESTA =
  matrícula nova E meta batida (dia 45 ligações; semana 225/70/6,5, sempre na
  virada <100% → ≥100%) — capivara feliz em **SVG original** (arte própria,
  sem personagem de terceiros) subindo e acenando, confete cheio, fanfarra
  WebAudio ~3,5 s, overlay de 6 s com nome e valor; `?festa=demo` dispara uma
  festa de exemplo ao carregar. DISCRETO = ingestão comum (pulso de borda +
  toast), sem festa — acontece várias vezes ao dia.
  **Legibilidade (2026-08-19)**: linha do consultor enxuta — nome,
  número principal (discadas × meta), barra, ritmo/atingimento e no máximo dois
  secundários (✨ leads e 🎓 matrículas; no dia, + comparativo de discadas da
  semana passada); atendidas/taxa/TMA/receita saíram da linha — detalhe fino é
  dos relatórios internos. **Tempo real por SSE**: ingestão concluída → evento → refetch;
  polling de 60 s como rede de segurança; diff no cliente anima contagem, dá
  glow em quem mudou/cruzou meta e dispara **celebração de matrícula nova** — **somente matrícula com criada_em de HOJE** (delta do painel do dia: backfill/lote histórico muda números sem confete) e com teto de segurança
  (overlay ~5 s com nome + valor, confete e som próprio — funciona sem som).
  **Toda ingestão concluída recebida por SSE** (nunca pelo polling) dispara o
  aviso: **pulso na borda da tela (~2,5 s)** + toast no canto com a fonte ("CDR
  atualizado", "Omie atualizado", "Unyflex sincronizado") + alerta sonoro curto
  se o som estiver armado; rajada de eventos = um aviso só (janela de 3 s),
  toast acumulando as fontes. **Som: silêncio é o padrão, não falha** — sem
  overlay de desbloqueio; a preferência global `tv_som` (toggle na /central)
  vem no payload, `?som=1|0` é override por dispositivo. Com som habilitado o
  cliente tenta armar o AudioContext direto (funciona com
  `--autoplay-policy=no-user-gesture-required`); se o navegador segurar, um 🔕
  discreto no rodapé arma com um clique (única interação da tela).
  `pessoas.entra_painel = 0` fica fora de dia/semana/rankings (receita só no
  mês); `entra_tv = 0` some da TV inteira, mês e "Equipe no mês" incluídos.
  Estado atual: Renato de volta a tudo (migração 14, 2026-08-25); Eduardo
  desde a migração 17 (2026-09-04), herdeiro do ramal 2001 e de todo o seu
  histórico;
  **Hirlan e Douglas fora da TV temporariamente desde
  2026-08-19, agora via `OCULTOS_TEMPORARIOS_TV` no fim do `db.js`** — lista
  aplicada em TODO startup, depois das migrações, então sobrevive a banco
  recriado do zero e a UPDATE manual em contrário. Reverter = remover o nome
  da lista e reiniciar (a restauração para 1/1 é automática e atinge só quem
  foi ocultado pela lista — rastreado em `configuracoes.tv_ocultos_aplicados`;
  Renato não passa por ela). Nenhuma ingestão cria linha em `pessoas` (nome
  sem match vira ressalva com `pessoa_id NULL`), então não há outro caminho de
  "renascimento" além do seed — já coberto pelo reforço. (As flags só afetam a
  TV; /relatorios, /saude e feedback continuam com todos.)
  "Sem dados" (tudo zero) é neutro cinza — vermelho só para atrasado com dado
  real. **Decisão revogada em 2026-08-18**: receita por consultor e ranking de
  receita APARECEM na TV; continua fora qualquer texto avaliativo sobre pessoas
  — só número, tudo do motor SQL, zero IA
- Validado contra a conferência da semana 10–14/08 (1.225+1 discadas, 723
  atendidas, taxas por consultor, 176 leads na janela, 4 vendas)
- **Painel de metas `/metas` e meta da equipe (2026-08-25, migração 14)**:
  tela autenticada para editar, sem SQL, o padrão da equipe e a meta própria
  de cada consultor (diária e mensal: ligações, leads, matrículas, R$;
  semanal: só receita, desde 2026-09-04, com projeção mensal × 52 ÷ 12 ao lado
  para comparar com a meta mensal — informação, nunca ajuste automático) com
  vigência por data (histórico preservado), mais a meta da EQUIPE em R$
  (semana e mês — número próprio, soma das individuais mostrada ao lado só
  para comparar) e o toggle da Gerencial. Na TV: **cartão de destaque "FALTA
  PARA A META DA SEMANA"** (R$ gigante + barra `.tv-trilha-grande` + "R$ feito
  de R$ meta · % · dia N de 5" + linha do mês) **intercalado entre CADA tela da
  rotação** (HOJE → cartão → SEMANA → cartão → RECEITA → cartão → MÊS →
  cartão), com duração
  própria `?destaque=N` s (padrão 12; as telas seguem com `?giro`), `?fixo=
  destaque` para fixar; sem meta da semana cadastrada o cartão sai da rotação
  (log no console). Receita da equipe para a meta = TODOS os consultores
  ativos, independente das flags de TV (quem está oculto continua vendendo) +
  Gerencial se o toggle estiver ligado. Visão MÊS: título sem valor único
  (meta de receita pode ser por pessoa), 2ª linha "📞 N/meta · ✨ N/meta · 🎓
  N/meta" só com metas mensais cadastradas, cartão Gerencial (valor, sem
  gauge/meta) e rodapé "Equipe no mês: R$ X de R$ Y (N%)" vindo de
  `mes.equipe` (não mais soma no cliente). Curva acumulada da SEMANA usa a
  soma das metas diárias de quem está no painel (respeita meta própria).
  `/relatorios` ganhou "Meta R$" e "%" por consultor (`receita_dia` × dias
  úteis; "—" em snapshot antigo).

### ✅ Etapa 3 (central de dados) — IA sobre as métricas (feedback individual concluído)
- `feedback.js` + migração 13: feedback individual por período congelado,
  gerado na tela /relatorios (detalhe do consultor). A IA **consome as métricas
  prontas do snapshot — nunca produz números**: o dossiê vai com tudo
  pré-formatado (R$, %, tempos) e até as comparações "acima/abaixo da média" e
  posições de ranking vêm calculadas em JS (deixar o modelo comparar decimais
  produziu conclusão invertida em teste). Minimização de dados: nomes de
  colegas nunca chegam ao modelo — só agregados da equipe e "Nº de M".
- Respeita `entra_feedback` (Renato → 403); elegibilidade vem do GET.
- Auditável: cada geração grava `fatos_json` (dossiê exato) + `snapshot_id`;
  regerar cria nova versão, com seletor de versões na tela.
- Pendente da etapa: outras aplicações de IA sobre as métricas (ex.: análise
  do período para a equipe), a priorizar.

### ✅ Inteligência comercial por território (`/territorio`, 2026-09-09, migrações 18–19)
Três níveis (estado PR/SC → regional → município) com receita e matrículas e
filtro de período; tudo em SQL, **sem IA**. Feito em três fases, cada uma
aprovada pelo usuário antes da seguinte. Revisão manual concluída em
2026-09-09: 11 pendências + 3 aproximados resolvidos por decisão do usuário
(CEP prevalece sobre nome digitado — "CONCORDIA" com CEP 83024 virou São
José dos Pinhais); 0 pendências, conferência fechando nos 4 elos:
- ✅ **Fase 1** — referência (`dados/`, migração 18), `state`/`cep` no sync,
  casamento cidade → município em camadas com método/confiança, tela de
  cobertura + revisão manual (pendências, aproximados, regional principal dos
  compartilhados). Ver "Território" em Banco de dados.
- ✅ **Fase 2** (2026-09-09, migração 19) — `agregarTerritorio(de, ate)`:
  estado/regional/município com o filtro canônico de `metricas.js`; regional
  soma só a principal, compartilhados à parte; `temHistorico` distingue "sem
  dado" de "zero no período"; conferência obrigatória em 4 elos, exibida com
  números e nunca ajustada. Navegação em tabelas com breadcrumb e
  `location.hash` (`#/`, `#/r/<id>`, `#/m/<código>` + `?de&ate`); cartão
  "Outros estados" por UF; detalhe do município (alunos distintos, cursos,
  ticket médio, carteira por vendedor, lista de alunos, aviso quando pertence
  a outra regional). Revisão manual com sugestão do sistema, confirmação em
  lote e consulta de CEP pelo navegador.
- ✅ **Fase 3** (2026-09-09) — mapas em SVG puro a partir de
  `dados/mapa_PR_SC.svg` (malha do IBGE, qualidade mínima, 127 KB, `path
  id="m<código>"`, servida por `GET /api/territorio/mapa` — sem CDN; o
  cliente baixa uma vez, mede o bbox de cada path num svg invisível e clona
  o `<g>` da UF a cada render). **ESTADO**: PR e SC lado a lado, cada
  município pintado pela faixa da regional principal (5 quantis sobre os
  valores > 0 do nível), rótulo da sigla no centro da regional, hover
  destaca a regional inteira, barra "N de M municípios já compraram" por
  estado e a comparação PR × SC em texto (SC: 77 de 295; PR: 278 de 399);
  cartões "Outros estados" (por UF), "Sem município" e total ao lado.
  **REGIONAL**: viewBox no bbox da regional (+8%), resto do estado esmaecido,
  município por faixa própria, nome de cada município (rótulos ficam fora do
  `transform` que espelha o eixo y — coordenadas convertidas), compartilhado
  hachurado (`<pattern>`), cartão "Nunca compraram — o próximo cliente" com
  chips. **MUNICÍPIO**: mesmo mapa com o município em traço branco + painel
  da Fase 2 + prospecção: receita da regional no período e quantos municípios
  dela já compraram, vizinhos clientes (N de M, com valores; tabela e chips
  clicáveis) e a lista "na regional, nunca compraram". Modos **Receita |
  Matrículas | Prospecção** (prospecção pinta cliente em ciano e nunca-comprou
  em âmbar, nos 3 níveis). Cores: **sem dado (nunca comprou) = cinza neutro
  `#232a3d` com traço**, zero no período = faixa mais escura da escala
  (mesma distinção da TV). `Esc` sobe um nível; tooltip próprio; sem
  biblioteca. Vizinhança vem de `dados/vizinhos_PR_SC.json` (gerado pelo
  script a partir da própria malha: ≥ 2 vértices em comum; ≥ 1 só para quem
  ficaria isolado — 1.926 fronteiras; `--so-vizinhos` regenera sem rede).
- Regenerar a referência do IBGE: `node scripts/gerar-referencias-territorio.js`
  (precisa de internet; commitar o resultado).

### 🚧 Prospecção ativa no jonIAs (`/prospeccao`, iniciada em 2026-09-09)
As planilhas de carteiras por setor (ATIVOS PARANÁ, ATIVO SANTA CATARINA;
SP fica para depois — mesma rota, só escolher a UF) passam a viver no
jonIAs, que vira a fonte oficial; o Excel será abandonado. Sem IA. Plano em
fases, cada uma aprovada antes da seguinte:
- ✅ **Fase 1 — carga com fidelidade total** (migração 20): importador
  `prospeccao.js` (ver "Prospecção ativa" em Banco de dados), upload na
  `/central` com UF, relatório por aba, tela `/prospeccao` (cores → status,
  cobertura, colunas não reconhecidas), pendências de município na revisão
  de `/territorio`. Decisões: linhas ocultas entram marcadas; abas atípicas
  importam o que casa e mandam o resto para extras; reimportação = upsert e
  aba editada no sistema é recusada.
- ✅ **Fase 2 — tela de trabalho do consultor** (2026-09-09, migração 22):
  aba Trabalho em `/prospeccao` — tudo em memória depois de uma chamada por
  UF, sem recarregar página; edição inline, status, registrar contato com
  histórico, novo contato, exportação .xlsx (ver "Migração 22" em Banco de
  dados). Consultor só para a equipe atual (decisão do usuário).
- ✅ **Fase 3 — papéis e escopo** (2026-09-09, migração 23): papel
  `vendedor` ligado a `pessoas`, carteiras por regional (titular + apoios),
  corte no servidor (ver "Migração 23" em Banco de dados), `/usuarios`
  (criação com senha inicial, carteiras), `/trocar-senha`, `/meu-painel`,
  aba Gerencial na prospecção (admin). Estoque medido antes de repartir:
  20.671 contatos sem consultor (13.549 nunca tocados) — tabela por regional
  no plano da fase.
- ✅ **Fase 4 — cruzamento com o CDR** (2026-09-10, migração 24): cada
  ligação classificada por número (ver "Migração 24" em Banco de dados).
  Telas: aba Gerencial ganhou "Ligações do CDR × carteiras" (período, cartões
  por classe, tabela por regional com municípios ligados/com contatos/nunca
  ligados/fora da carteira e quem ligou, tabela por consultor, lista de
  números ambíguos com clique que abre os contatos na aba Trabalho na UF
  certa para corrigir o município, desconhecidas por DDD, botão "Recalcular
  cruzamento"); aba Trabalho ganhou a coluna **📟 CDR** (data×quantidade da
  última ligação ao número exato — em ciano — ou ao município, com quem ligou
  no tooltip; ordenável), o filtro "nunca ligado (CDR)" (`flags=nuncaCdr` no
  hash) e a seção "Ligações do PABX" na gaveta; `/meu-painel` ganhou "Minhas
  ligações × carteira" (cartões por classe, tabela por regional com "outros
  consultores" só em número, chips dos municípios da carteira sem ligação no
  período linkando para a tela de trabalho). Decisões do usuário: ambígua não
  conta; só leitura; classificação estendida a Omie e matrículas.

### Etapa 4 — Ideias futuras (a priorizar)
- Multiusuário completo (cadastro/gestão de usuários — a base já existe na Etapa 0)
- Glossário automático de termos-chave
- Compartilhamento de resumo por link público somente leitura
- Seleção de idioma / tamanho de bloco pela interface
- Streaming do resumo para aulas longas
