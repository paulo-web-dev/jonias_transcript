"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// ---------- Caminho do banco ----------
// Em produção (Docker) o banco PRECISA ficar dentro do diretório montado como
// volume (ex.: DB_PATH=/app/data/aula-ai.db com ./data:/app/data) — senão cada
// `docker compose build` recria o container e o banco volta ao que estava na
// imagem. DB_PATH aponta para um ARQUIVO dentro de um DIRETÓRIO montado (nunca
// bind de arquivo único): o SQLite cria -wal e -shm ao lado do .db, e eles têm
// de viver no mesmo lugar. Sem DB_PATH (desenvolvimento local) vale o caminho
// histórico, na raiz do projeto.
//
// Com DB_PATH definido o boot falha ALTO — melhor não subir que criar um banco
// vazio em silêncio num lugar que some no próximo deploy:
//   - diretório inexistente ou não gravável → sai;
//   - arquivo inexistente → sai, a não ser que DB_CRIAR_NOVO=1 (primeira
//     instalação de verdade, feita de propósito).
function falharBanco(msg) {
  console.error(`\n✖  BANCO: ${msg}\n   O servidor NÃO vai subir (nenhum banco foi criado).\n`);
  process.exit(1);
}

function resolverCaminhoBanco() {
  const bruto = (process.env.DB_PATH || "").trim();
  if (!bruto) {
    // Em produção o caminho padrão fica DENTRO do container — some no rebuild
    if (process.env.NODE_ENV === "production") {
      falharBanco("NODE_ENV=production sem DB_PATH — o banco ficaria dentro do container e sumiria no próximo build. Defina DB_PATH=/app/data/aula-ai.db (ver DEPLOY.md).");
    }
    const padrao = path.join(__dirname, "aula-ai.db");
    if (!fs.existsSync(padrao)) console.warn(`⚠  BANCO: ${padrao} não existia — criando um banco NOVO e vazio.`);
    return padrao;
  }

  const caminho = path.resolve(bruto);
  const dir = path.dirname(caminho);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    falharBanco(`DB_PATH=${bruto} — o diretório ${dir} não existe (o volume está montado?).`);
  }
  if (!st.isDirectory()) falharBanco(`DB_PATH=${bruto} — ${dir} não é um diretório.`);
  // access(W_OK) nem sempre reflete o volume real; a prova é gravar de fato.
  const sonda = path.join(dir, `.teste-escrita-${process.pid}`);
  try {
    fs.writeFileSync(sonda, "ok");
    fs.unlinkSync(sonda);
  } catch (e) {
    falharBanco(`DB_PATH=${bruto} — o diretório ${dir} não é gravável (${e.code || e.message}).`);
  }
  if (fs.existsSync(caminho)) {
    if (!fs.statSync(caminho).isFile()) falharBanco(`DB_PATH=${bruto} — ${caminho} existe e não é um arquivo.`);
  } else if (process.env.DB_CRIAR_NOVO !== "1") {
    falharBanco(
      `DB_PATH=${bruto} — o arquivo ${caminho} não existe. Se o banco foi movido, confira o volume.\n` +
        `   Para criar um banco NOVO e vazio de propósito, suba uma vez com DB_CRIAR_NOVO=1.`
    );
  }
  return caminho;
}

const CAMINHO_BANCO = resolverCaminhoBanco();
const db = new Database(CAMINHO_BANCO);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------- Migrações ----------
// Versionamento via PRAGMA user_version: cada função abaixo leva o banco da
// versão N-1 para a versão N, dentro de uma transação (se falhar, a versão não
// avança). Bancos novos e antigos passam pelo mesmo caminho — a migração 1 é o
// baseline idempotente (CREATE IF NOT EXISTS) que ambos já satisfazem.

// Grafias do Jhonnata no Vendedor do Omie e no wallet da Unyflex (migração 26).
// Nome completo: Jhonnata Henrick de Lima Ribeiro (cadastro 55622 no painel da
// Unyflex). O casamento é exato (nome normalizado, sem acento/caixa), então as
// combinações prováveis entram explícitas — nunca palpite por primeiro nome.
const NOMES_JHONNATA = [
  "Jhonnata",
  "Jhonnata Henrick de Lima Ribeiro",
  "Jhonnata Henrick Lima Ribeiro",
  "Jhonnata Henrick",
  "Jhonnata Ribeiro",
  "Jhonnata Lima Ribeiro",
  "Jhonnata Henrick Ribeiro",
  "Jhonnata de Lima Ribeiro",
];

const MIGRACOES = [
  // 1 — baseline: aulas + anotações
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS aulas (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        nome                 TEXT    NOT NULL,
        data_criacao         TEXT    NOT NULL,
        status               TEXT    NOT NULL DEFAULT 'em_andamento',
        duracao              INTEGER NOT NULL DEFAULT 0,
        transcricao_completa TEXT    NOT NULL DEFAULT '',
        resumo_md            TEXT    NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS anotacoes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        aula_id   INTEGER NOT NULL REFERENCES aulas(id) ON DELETE CASCADE,
        texto     TEXT    NOT NULL,
        timestamp TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_anotacoes_aula ON anotacoes(aula_id);
    `);
  },

  // 2 — usuários e posse das aulas. usuario_id entra nullable porque o SQLite
  // não permite ADD COLUMN NOT NULL sem default constante; o seed no startup
  // (auth.js) faz o backfill e a aplicação sempre grava o dono.
  () => {
    db.exec(`
      CREATE TABLE usuarios (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        login      TEXT    NOT NULL UNIQUE,
        senha_hash TEXT    NOT NULL,
        nome       TEXT    NOT NULL DEFAULT '',
        papel      TEXT    NOT NULL DEFAULT 'admin',
        ativo      INTEGER NOT NULL DEFAULT 1,
        criado_em  TEXT    NOT NULL
      );

      ALTER TABLE aulas ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);
      CREATE INDEX idx_aulas_usuario ON aulas(usuario_id);
    `);
  },

  // 3 — bloqueio progressivo de tentativas de login (por IP e por login)
  () => {
    db.exec(`
      CREATE TABLE login_bloqueios (
        chave         TEXT PRIMARY KEY,
        falhas        INTEGER NOT NULL DEFAULT 0,
        bloqueado_ate TEXT
      );
    `);
  },

  // 4 — Etapa 1: modelo canônico da central de dados.
  // pessoas unifica os três identificadores (ramal PABX, user_id do CRM e nome
  // do wallet); ligacoes/oportunidades vêm de upload de CSV (upsert por chave
  // natural); turmas/matriculas são cópia snapshot do MySQL da Unyflex;
  // importacoes é a auditoria de toda ingestão. Datas/horas operacionais em
  // horário local (sem Z) — os relatórios raciocinam em dia local.
  () => {
    db.exec(`
      CREATE TABLE pessoas (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        nome           TEXT    NOT NULL,
        ramal          TEXT    UNIQUE,
        crm_user_id    INTEGER UNIQUE,
        wallet_nome    TEXT    UNIQUE,
        ativo          INTEGER NOT NULL DEFAULT 1,
        entra_feedback INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE importacoes (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo                  TEXT    NOT NULL CHECK (tipo IN ('cdr','oportunidades','mysql')),
        arquivo_nome          TEXT,
        hash_sha256           TEXT,
        linhas_lidas          INTEGER NOT NULL DEFAULT 0,
        linhas_validas        INTEGER NOT NULL DEFAULT 0,
        linhas_ignoradas      INTEGER NOT NULL DEFAULT 0,
        registros_novos       INTEGER NOT NULL DEFAULT 0,
        registros_atualizados INTEGER NOT NULL DEFAULT 0,
        detalhes_json         TEXT    NOT NULL DEFAULT '{}',
        status                TEXT    NOT NULL DEFAULT 'concluida' CHECK (status IN ('concluida','erro')),
        erro                  TEXT,
        usuario_id            INTEGER NOT NULL REFERENCES usuarios(id),
        iniciado_em           TEXT    NOT NULL,
        concluido_em          TEXT
      );
      CREATE INDEX idx_importacoes_tipo ON importacoes(tipo, iniciado_em);
      CREATE INDEX idx_importacoes_hash ON importacoes(hash_sha256);

      CREATE TABLE ligacoes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        cdr_id        TEXT    NOT NULL UNIQUE,
        data_hora     TEXT,
        ramal         TEXT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        numero_a      TEXT,
        numero_b      TEXT,
        sentido       TEXT,
        fila          TEXT,
        duracao_seg   INTEGER NOT NULL DEFAULT 0,
        atendida      INTEGER NOT NULL DEFAULT 0,
        eventos       INTEGER NOT NULL DEFAULT 1,
        gravacao      TEXT,
        importacao_id INTEGER NOT NULL REFERENCES importacoes(id)
      );
      CREATE INDEX idx_ligacoes_pessoa_data ON ligacoes(pessoa_id, data_hora);
      CREATE INDEX idx_ligacoes_data ON ligacoes(data_hora);

      CREATE TABLE oportunidades (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        crm_id            TEXT    NOT NULL UNIQUE,
        titulo            TEXT,
        organizacao       TEXT,
        receita_centavos  INTEGER,
        etapa             TEXT,
        funil             TEXT,
        motivo_perda      TEXT,
        origem            TEXT,
        formulario        TEXT,
        oferta            TEXT,
        linha_produto     TEXT,
        produtos          TEXT,
        responsavel       TEXT,
        pessoa_id         INTEGER REFERENCES pessoas(id),
        criado_em         TEXT,
        alterado_em       TEXT,
        tempo_etapas_json TEXT,
        importacao_id     INTEGER NOT NULL REFERENCES importacoes(id)
      );
      CREATE INDEX idx_oportunidades_pessoa ON oportunidades(pessoa_id, criado_em);
      CREATE INDEX idx_oportunidades_etapa  ON oportunidades(etapa);

      CREATE TABLE turmas (
        id              INTEGER PRIMARY KEY,
        nome            TEXT,
        start_date      TEXT,
        sincronizado_em TEXT NOT NULL
      );

      CREATE TABLE matriculas (
        id              INTEGER PRIMARY KEY,
        turma_id        INTEGER NOT NULL REFERENCES turmas(id),
        student_id      INTEGER,
        aluno_nome      TEXT,
        aluno_email     TEXT,
        aluno_telefone  TEXT,
        aluno_cidade    TEXT,
        wallet          TEXT,
        pessoa_id       INTEGER REFERENCES pessoas(id),
        criada_em       TEXT,
        sincronizado_em TEXT NOT NULL
      );
      CREATE INDEX idx_matriculas_pessoa ON matriculas(pessoa_id, criada_em);
      CREATE INDEX idx_matriculas_turma  ON matriculas(turma_id);

      CREATE TABLE metas (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        indicador     TEXT    NOT NULL CHECK (indicador IN ('ligacoes_dia','leads_dia','matriculas_dia')),
        valor         REAL    NOT NULL,
        vigente_desde TEXT    NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (indicador, pessoa_id, vigente_desde)
      );

      CREATE TABLE periodos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nome        TEXT NOT NULL,
        data_inicio TEXT NOT NULL,
        data_fim    TEXT NOT NULL,
        criado_em   TEXT NOT NULL,
        UNIQUE (data_inicio, data_fim)
      );

      -- Seed: consultores atuais (crm_user_id do Frederico pendente de
      -- confirmação; Renato não entra em relatório de feedback individual)
      INSERT INTO pessoas (nome, ramal, crm_user_id, wallet_nome, ativo, entra_feedback) VALUES
        ('Bianca',    '2000', 55337, 'Bianca',    1, 1),
        ('Hirlan',    '2001', 53159, 'Hirlan',    1, 1),
        ('Agnes',     '2002', 55324, 'Agnes',     1, 1),
        ('Renato',    '2003', 53317, 'Renato',    1, 0),
        ('Douglas',   '2004', 53554, 'Douglas',   1, 1),
        ('Frederico', '2005', NULL,  'Frederico', 1, 1);

      -- Seed: metas padrão vigentes (pessoa_id NULL = vale para todos)
      INSERT INTO metas (pessoa_id, indicador, valor, vigente_desde) VALUES
        (NULL, 'ligacoes_dia',   45,  '2026-08-17'),
        (NULL, 'leads_dia',      14,  '2026-08-17'),
        (NULL, 'matriculas_dia', 1.3, '2026-08-17');
    `);
  },

  // 5 — Oportunidades passam a vir do Omie (.xlsx), não mais do Ramper.
  // A tabela antiga (formato Ramper, vazia) é substituída pelo modelo Omie:
  // "Fase Atual" e "Status" são dimensões independentes (um Perdido continua
  // registrado na fase onde parou), cada fase tem a data de entrada (colunas
  // "Data de <fase>" do arquivo; as duas sem nome são as fases 04 e 05) e o
  // upsert por "Número" nunca apaga o que não veio no arquivo — cada exportação
  // é um retrato de janela recente e o banco é a união de todas.
  () => {
    db.exec(`
      -- Nomes completos como aparecem na coluna "Vendedor" do Omie (JSON array)
      ALTER TABLE pessoas ADD COLUMN nomes_alternativos TEXT;
      UPDATE pessoas SET nomes_alternativos = CASE nome
        WHEN 'Bianca'    THEN json_array('Bianca Destro')
        WHEN 'Hirlan'    THEN json_array('Hirlan Rosário')
        WHEN 'Agnes'     THEN json_array('Agnes Dias Ramos')
        WHEN 'Renato'    THEN json_array('Renato')
        WHEN 'Douglas'   THEN json_array('Douglas Gotordelli Alves Martins')
        WHEN 'Frederico' THEN json_array('Frederico Vieira')
        ELSE nomes_alternativos END;

      ALTER TABLE importacoes ADD COLUMN registros_identicos INTEGER NOT NULL DEFAULT 0;

      DROP TABLE oportunidades;
      CREATE TABLE oportunidades (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        numero           TEXT    NOT NULL UNIQUE,
        conta            TEXT,
        cnpj_cpf         TEXT,
        solucao          TEXT,
        titulo           TEXT,
        contato          TEXT,
        vendedor         TEXT,
        pessoa_id        INTEGER REFERENCES pessoas(id),
        tipo_cliente     TEXT,
        fase_atual       TEXT,
        status           TEXT,
        motivo_conclusao TEXT,
        fase_01_em       TEXT,
        fase_02_em       TEXT,
        fase_03_em       TEXT,
        fase_04_em       TEXT,
        fase_05_em       TEXT,
        fase_06_em       TEXT,
        produtos_centavos    INTEGER,
        servicos_centavos    INTEGER,
        recorrencia_centavos INTEGER,
        meses            INTEGER,
        ticket_centavos  INTEGER,
        temperatura      INTEGER,
        origem           TEXT,
        vertical         TEXT,
        telefone         TEXT,
        celular_1        TEXT,
        celular_2        TEXT,
        email            TEXT,
        incluido_em      TEXT,
        atualizado_em    TEXT,
        extras_json      TEXT,
        importacao_id    INTEGER NOT NULL REFERENCES importacoes(id)
      );
      CREATE INDEX idx_oportunidades_pessoa   ON oportunidades(pessoa_id, incluido_em);
      CREATE INDEX idx_oportunidades_fase     ON oportunidades(fase_atual);
      CREATE INDEX idx_oportunidades_status   ON oportunidades(status);
      CREATE INDEX idx_oportunidades_origem   ON oportunidades(origem);
      CREATE INDEX idx_oportunidades_incluido ON oportunidades(incluido_em);

      CREATE TABLE oportunidade_mudancas (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        oportunidade_id INTEGER NOT NULL REFERENCES oportunidades(id) ON DELETE CASCADE,
        campo           TEXT    NOT NULL CHECK (campo IN ('fase_atual','status','motivo_conclusao','ticket_centavos')),
        valor_anterior  TEXT,
        valor_novo      TEXT,
        observado_em    TEXT    NOT NULL,
        importacao_id   INTEGER NOT NULL REFERENCES importacoes(id)
      );
      CREATE INDEX idx_mudancas_oportunidade ON oportunidade_mudancas(oportunidade_id, observado_em);
    `);
  },

  // 6 — Sinais brutos de atendimento por ligação. A DURAÇÃO do CDR inclui o
  // tempo de toque (Ocupado/Não atendeu saem com duração > 0), então "atendida"
  // passa a ser DERIVADA dos sinais: atendida = tem_evento_atendida. Os sinais
  // ficam persistidos para a regra poder mudar depois por SQL, sem reimportar.
  // duracao_seg segue guardando a duração bruta do arquivo (toque + conversa).
  () => {
    db.exec(`
      ALTER TABLE ligacoes ADD COLUMN tem_evento_atendida INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ligacoes ADD COLUMN evento_falha        TEXT;    -- Ocupado|Não atendeu|Rejeitada|Destino Desconectado (como veio)
      ALTER TABLE ligacoes ADD COLUMN atendida_em         TEXT;    -- hora do evento "Atendida"
      ALTER TABLE ligacoes ADD COLUMN encerrada_em        TEXT;    -- hora do último evento "Encerrada"
      ALTER TABLE ligacoes ADD COLUMN tempo_toque_seg     INTEGER; -- início → atendida_em
      ALTER TABLE ligacoes ADD COLUMN tempo_conversa_seg  INTEGER; -- atendida_em → encerrada_em (TMA usa isto, nunca duracao_seg)
    `);
  },

  // 7 — Sync real do MySQL: o esquema confirmado usa classes.title/subtitle
  // (não "name") e o cancelamento vive em enrollments.status ('canceled' não
  // conta como receita). matriculas deixa de ser full-replace (vira upsert
  // incremental), então turmas nunca são apagadas e o resultado do cruzamento
  // matrícula ↔ oportunidade (por e-mail/telefone) persiste entre syncs.
  () => {
    db.exec(`
      ALTER TABLE turmas ADD COLUMN subtitulo TEXT;
      ALTER TABLE turmas ADD COLUMN end_date  TEXT;

      ALTER TABLE matriculas ADD COLUMN status          TEXT;    -- enum da origem; 'canceled' = fora da receita
      ALTER TABLE matriculas ADD COLUMN valor_centavos  INTEGER; -- final_value * 100
      ALTER TABLE matriculas ADD COLUMN oportunidade_id INTEGER REFERENCES oportunidades(id);
      ALTER TABLE matriculas ADD COLUMN match_metodo    TEXT;    -- 'email' | 'telefone'
      ALTER TABLE matriculas ADD COLUMN match_confianca TEXT;    -- 'alta' | 'media' | 'baixa'
      CREATE INDEX idx_matriculas_oportunidade ON matriculas(oportunidade_id);

      -- Formatos reais do enrollments.wallet entram como nomes alternativos
      UPDATE pessoas SET nomes_alternativos = CASE nome
        WHEN 'Bianca'    THEN json_array('Bianca Destro')
        WHEN 'Hirlan'    THEN json_array('Hirlan Rosário', 'Hirlan Silva Santos do Rosario')
        WHEN 'Agnes'     THEN json_array('Agnes Dias Ramos', 'Agnes Ramos')
        WHEN 'Renato'    THEN json_array('Renato', 'Renato Fernando da Silva Monteiro')
        WHEN 'Douglas'   THEN json_array('Douglas Gotordelli Alves Martins')
        WHEN 'Frederico' THEN json_array('Frederico Vieira', 'Frederico Alberto Vieira')
        ELSE nomes_alternativos END;
    `);
  },

  // 8 — Etapa 2: pessoas ganham tipo ('consultor' | 'canal') e os períodos
  // ganham snapshots versionados. O canal Unyflex entra nos totais da empresa
  // mas nunca em ranking, metas ou feedback. Cada congelamento de período é
  // uma versão nova em periodo_snapshots — versões antigas ficam guardadas
  // (dá para dizer quando e por que um número mudou).
  () => {
    db.exec(`
      ALTER TABLE pessoas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'consultor';

      INSERT INTO pessoas (nome, wallet_nome, ativo, entra_feedback, tipo, nomes_alternativos)
      VALUES ('Unyflex', 'Unyflex', 1, 0, 'canal', json_array());

      -- Reatribui as matrículas já sincronizadas do balcão (só o wallet exato;
      -- "Unyflex U" segue sem match por decisão do usuário)
      UPDATE matriculas
         SET pessoa_id = (SELECT id FROM pessoas WHERE nome = 'Unyflex' AND tipo = 'canal')
       WHERE pessoa_id IS NULL AND TRIM(wallet) = 'Unyflex';

      CREATE TABLE periodo_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        periodo_id  INTEGER NOT NULL REFERENCES periodos(id) ON DELETE CASCADE,
        criado_em   TEXT    NOT NULL,
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
        dias_uteis  INTEGER NOT NULL,
        dados_json  TEXT    NOT NULL
      );
      CREATE INDEX idx_snapshots_periodo ON periodo_snapshots(periodo_id, id);
    `);
  },

  // 9 — Metas padrão retroativas: o seed da migração 4 fixou vigente_desde no
  // dia do deploy (2026-08-17), deixando qualquer período anterior sem meta.
  // As metas 45/14/1,3 valem como padrão histórico desde o início do ano.
  () => {
    db.exec(`
      UPDATE metas SET vigente_desde = '2026-01-01'
       WHERE pessoa_id IS NULL AND vigente_desde = '2026-08-17';
    `);
  },

  // 10 — Meta mensal de receita (R$ 75.000/mês por consultor, em CENTAVOS).
  // O CHECK de metas.indicador é fixo e o SQLite não altera CHECK — a tabela é
  // recriada com o indicador novo, preservando dados e constraints.
  () => {
    db.exec(`
      CREATE TABLE metas_nova (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        indicador     TEXT    NOT NULL CHECK (indicador IN ('ligacoes_dia','leads_dia','matriculas_dia','receita_mes')),
        valor         REAL    NOT NULL,
        vigente_desde TEXT    NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (indicador, pessoa_id, vigente_desde)
      );
      INSERT INTO metas_nova (id, pessoa_id, indicador, valor, vigente_desde, vigente_ate)
        SELECT id, pessoa_id, indicador, valor, vigente_desde, vigente_ate FROM metas;
      DROP TABLE metas;
      ALTER TABLE metas_nova RENAME TO metas;

      INSERT INTO metas (pessoa_id, indicador, valor, vigente_desde)
      VALUES (NULL, 'receita_mes', 7500000, '2026-01-01');
    `);
  },

  // 11 — Flag do painel de TV: quem não faz prospecção (Renato) não aparece
  // nas visões de dia/semana nem em ranking — mostrá-lo como "atrasado" na
  // parede seria errado. A receita dele continua na visão do mês.
  () => {
    db.exec(`
      ALTER TABLE pessoas ADD COLUMN entra_painel INTEGER NOT NULL DEFAULT 1;
      UPDATE pessoas SET entra_painel = 0 WHERE nome = 'Renato';
    `);
  },

  // 12 — Ocultação completa da TV e configurações globais.
  // entra_tv = 0 tira a pessoa de TODAS as visões da TV (mês incluído);
  // entra_painel continua sendo só as visões de prospecção (dia/semana) —
  // Renato segue entra_painel = 0 / entra_tv = 1: receita visível no mês.
  // Ocultações temporárias (ex.: Hirlan/Douglas) são UPDATE em runtime, não
  // migração. `configuracoes` é chave→valor; tv_som nasce desligado — o
  // silêncio é o padrão da TV, não uma falha.
  () => {
    db.exec(`
      ALTER TABLE pessoas ADD COLUMN entra_tv INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE configuracoes (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      );
      INSERT INTO configuracoes (chave, valor) VALUES ('tv_som', '0');
    `);
  },

  // 13 — Feedback individual com IA (Etapa 3). Cada geração fica gravada com o
  // dossiê de fatos EXATO enviado ao modelo (fatos_json) e o snapshot que o
  // originou — o texto é sempre auditável contra números congelados. Gerações
  // antigas nunca são sobrescritas (trilha de versões, como nos snapshots).
  () => {
    db.exec(`
      CREATE TABLE feedbacks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        periodo_id  INTEGER NOT NULL REFERENCES periodos(id) ON DELETE CASCADE,
        snapshot_id INTEGER NOT NULL REFERENCES periodo_snapshots(id) ON DELETE CASCADE,
        pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id),
        modelo      TEXT    NOT NULL,
        fatos_json  TEXT    NOT NULL,
        texto_md    TEXT    NOT NULL,
        criado_em   TEXT    NOT NULL,
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id)
      );
      CREATE INDEX idx_feedbacks_periodo ON feedbacks(periodo_id, pessoa_id, id);
    `);
  },

  // 14 — Painel de metas, meta da equipe, Renato de volta e carteira Gerencial
  // (decisões do usuário, 2026-08-25).
  // - Renato volta a rankings, metas e feedback (entra_painel = 1,
  //   entra_feedback = 1). Hirlan/Douglas seguem em OCULTOS_TEMPORARIOS_TV.
  // - `metas` é recriada com o CHECK ampliado (o SQLite não altera CHECK):
  //   diário (ligacoes/leads/matriculas/receita _dia), mensal (_mes) e os
  //   indicadores próprios da EQUIPE em R$ (receita_semana_equipe /
  //   receita_mes_equipe, sempre pessoa_id NULL — número próprio, não a soma).
  //   Nenhum valor novo é semeado: quem define é o painel /metas.
  // - "Gerencial": carteira tipo 'canal' (fora de ranking/metas de ligação).
  //   Recebe matrículas com wallet contendo "gere" (única grafia real hoje:
  //   'Gerencial') e oportunidades do Omie cujo vendedor é Paulo ou Gustavo;
  //   variações de nome completo entram em nomes_alternativos quando surgirem.
  //   Backfill só onde pessoa_id ainda é NULL (nunca reatribui).
  // - meta_equipe_inclui_gerencial: se a carteira conta para a meta da equipe
  //   em R$ (nasce '0'; o painel mostra o impacto e liga sem deploy).
  () => {
    db.exec(`
      UPDATE pessoas SET entra_painel = 1, entra_feedback = 1 WHERE nome = 'Renato';

      CREATE TABLE metas_nova (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        indicador     TEXT    NOT NULL CHECK (indicador IN (
                        'ligacoes_dia', 'leads_dia', 'matriculas_dia', 'receita_dia',
                        'ligacoes_mes', 'leads_mes', 'matriculas_mes', 'receita_mes',
                        'receita_semana_equipe', 'receita_mes_equipe')),
        valor         REAL    NOT NULL,
        vigente_desde TEXT    NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (indicador, pessoa_id, vigente_desde)
      );
      INSERT INTO metas_nova (id, pessoa_id, indicador, valor, vigente_desde, vigente_ate)
        SELECT id, pessoa_id, indicador, valor, vigente_desde, vigente_ate FROM metas;
      DROP TABLE metas;
      ALTER TABLE metas_nova RENAME TO metas;

      INSERT INTO pessoas (nome, wallet_nome, ativo, entra_feedback, tipo, entra_painel, entra_tv, nomes_alternativos)
      VALUES ('Gerencial', 'Gerencial', 1, 0, 'canal', 0, 1,
              json_array('Paulo', 'Gustavo', 'Paulo Orfanelli'));

      UPDATE matriculas
         SET pessoa_id = (SELECT id FROM pessoas WHERE nome = 'Gerencial' AND tipo = 'canal')
       WHERE pessoa_id IS NULL
         AND (lower(wallet) LIKE '%gere%'
              OR lower(trim(wallet)) IN ('paulo', 'gustavo', 'paulo orfanelli'));

      UPDATE oportunidades
         SET pessoa_id = (SELECT id FROM pessoas WHERE nome = 'Gerencial' AND tipo = 'canal')
       WHERE pessoa_id IS NULL
         AND lower(trim(vendedor)) IN ('paulo', 'gustavo', 'paulo orfanelli');

      INSERT INTO configuracoes (chave, valor) VALUES ('meta_equipe_inclui_gerencial', '0');
    `);
  },

  // 15 — Turmas unyflex = 1 passam a entrar na cópia local (decisão do
  // usuário, 2026-09-01), só com matrículas de final_value > R$ 1.000 (o
  // corte fica em sincronizacao.js). A coluna guarda a flag da origem para
  // que a receita nova seja separável por SQL ("de onde veio este número");
  // nasce NULL e é preenchida no próximo sync (as turmas vêm inteiras sempre).
  // QUEBRA DE COMPARABILIDADE: relatórios/snapshots anteriores a esta data não
  // incluem essas matrículas — ver CLAUDE.md.
  () => {
    db.exec("ALTER TABLE turmas ADD COLUMN unyflex INTEGER;");
  },

  // 16 — Meta de RECEITA POR SEMANA por vendedor (decisão do usuário,
  // 2026-09-04): indicador `receita_semana` (centavos, pessoa_id NULL =
  // padrão herdado), mesma vigência das outras metas, editável em /metas
  // (escopo "semana") e base da visão RECEITA DA SEMANA da TV. `metas` é
  // recriada porque o SQLite não altera CHECK.
  // Seed: R$ 20.000/semana para todos desde a data da decisão.
  // INCONSISTÊNCIA CONHECIDA (não corrigir aqui): R$ 20.000 × 52 ÷ 12 ≈
  // R$ 86.667/mês, acima da meta mensal vigente de R$ 75.000. O painel
  // /metas mostra a projeção ao lado do campo; a decisão é do usuário.
  () => {
    db.exec(`
      CREATE TABLE metas_nova (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        indicador     TEXT    NOT NULL CHECK (indicador IN (
                        'ligacoes_dia', 'leads_dia', 'matriculas_dia', 'receita_dia',
                        'receita_semana',
                        'ligacoes_mes', 'leads_mes', 'matriculas_mes', 'receita_mes',
                        'receita_semana_equipe', 'receita_mes_equipe')),
        valor         REAL    NOT NULL,
        vigente_desde TEXT    NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (indicador, pessoa_id, vigente_desde)
      );
      INSERT INTO metas_nova (id, pessoa_id, indicador, valor, vigente_desde, vigente_ate)
        SELECT id, pessoa_id, indicador, valor, vigente_desde, vigente_ate FROM metas;
      DROP TABLE metas;
      ALTER TABLE metas_nova RENAME TO metas;

      INSERT INTO metas (pessoa_id, indicador, valor, vigente_desde)
        VALUES (NULL, 'receita_semana', 2000000, '2026-09-04');
    `);
  },

  // 17 — Vendedor novo Eduardo e ramal 2001 consolidado nele (decisão do
  // usuário, 2026-09-04).
  // - "Andrey Eduardo Dudek" no wallet das matrículas e no Vendedor do Omie;
  //   exibido como "Eduardo". Metas: herda o padrão. Flags 1/1/1.
  // - O ramal 2001 era do Hirlan. SEM vigência por data (decisão explícita):
  //   TODO o histórico de ligações do 2001 passa a ser do Eduardo, inclusive
  //   as ligações antigas que apareciam como do Hirlan. Hirlan fica sem ramal
  //   e continua em OCULTOS_TEMPORARIOS_TV.
  // QUEBRA DE COMPARABILIDADE: snapshots congelados antes desta data guardam
  // as ligações do 2001 no Hirlan; um recálculo/recongelamento as põe no
  // Eduardo — ver CLAUDE.md. O número de ligações reatribuídas sai no log.
  () => {
    db.exec(`
      UPDATE pessoas SET ramal = NULL WHERE nome = 'Hirlan';
      INSERT INTO pessoas (nome, ramal, crm_user_id, wallet_nome, ativo, entra_feedback,
                           tipo, entra_painel, entra_tv, nomes_alternativos)
      VALUES ('Eduardo', '2001', NULL, 'Eduardo', 1, 1, 'consultor', 1, 1,
              json_array('Andrey Eduardo Dudek', 'Andrey Eduardo', 'Eduardo Dudek', 'Andrey Dudek'));
    `);
    const eduardo = db.prepare("SELECT id FROM pessoas WHERE nome = 'Eduardo' AND tipo = 'consultor'").get().id;
    const ligacoes = db
      .prepare("UPDATE ligacoes SET pessoa_id = ? WHERE ramal = '2001' AND (pessoa_id IS NULL OR pessoa_id != ?)")
      .run(eduardo, eduardo).changes;
    console.log(`migração 17: ${ligacoes} ligação(ões) do ramal 2001 reatribuída(s) ao Eduardo (histórico consolidado, sem vigência).`);
    // Backfill idempotente só onde ainda não há atribuição (mesmo padrão da Gerencial)
    const nomes = ["andrey eduardo dudek", "andrey eduardo", "eduardo dudek", "andrey dudek", "eduardo"];
    const marcadores = nomes.map(() => "?").join(", ");
    const mat = db
      .prepare(`UPDATE matriculas SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(wallet)) IN (${marcadores})`)
      .run(eduardo, ...nomes).changes;
    const opo = db
      .prepare(`UPDATE oportunidades SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(vendedor)) IN (${marcadores})`)
      .run(eduardo, ...nomes).changes;
    if (mat || opo) console.log(`migração 17: backfill Eduardo — ${mat} matrícula(s), ${opo} oportunidade(s).`);
  },

  // 18 — Inteligência comercial por território (2026-09-09).
  // Referência: regionais e municípios de PR/SC (carregados no boot a partir
  // de dados/regionais_municipios_PR_SC.csv + dados/municipios_ibge_PR_SC.json
  // por territorio.js — ver carregarReferencias). Um município pode estar em
  // duas regionais (20 casos no PR): regional_municipios guarda TODOS os
  // vínculos e municipios.regional_principal_id elege a que conta nos totais
  // (decisão do usuário: mapa e somas usam só a principal; a outra mostra o
  // município como "compartilhado", à parte).
  // Casamento students.city (texto livre) → município: municipio_apelidos tem
  // 1 linha por (cidade normalizada, UF normalizada) com método e confiança;
  // resolução manual é 'manual' e nunca é sobrescrita. matriculas ganha
  // aluno_estado/aluno_cep (novos no sync) e codigo_ibge + método/confiança
  // do casamento. sync_completo_pendente força a próxima sincronização a
  // trazer TODAS as matrículas (estado e CEP das antigas).
  () => {
    db.exec(`
      CREATE TABLE regionais (
        id          INTEGER PRIMARY KEY,
        uf          TEXT NOT NULL,
        sigla       TEXT NOT NULL,
        nome        TEXT,
        cidade_polo TEXT,
        UNIQUE (uf, sigla)
      );
      CREATE TABLE municipios (
        codigo_ibge           INTEGER PRIMARY KEY,
        uf                    TEXT NOT NULL,
        nome                  TEXT NOT NULL,
        nome_normalizado      TEXT NOT NULL,
        regional_principal_id INTEGER REFERENCES regionais(id)
      );
      CREATE INDEX idx_municipios_nome ON municipios(uf, nome_normalizado);
      CREATE TABLE regional_municipios (
        regional_id INTEGER NOT NULL REFERENCES regionais(id),
        codigo_ibge INTEGER NOT NULL REFERENCES municipios(codigo_ibge),
        ordem       INTEGER NOT NULL,          -- posição da linha no CSV (1ª ocorrência = principal padrão)
        PRIMARY KEY (regional_id, codigo_ibge)
      );
      CREATE TABLE municipio_apelidos (
        id               INTEGER PRIMARY KEY,
        cidade_norm      TEXT NOT NULL,
        uf_norm          TEXT NOT NULL DEFAULT '',
        resultado        TEXT NOT NULL CHECK (resultado IN ('municipio', 'fora', 'ignorar', 'pendente')),
        codigo_ibge      INTEGER REFERENCES municipios(codigo_ibge),
        metodo           TEXT NOT NULL CHECK (metodo IN ('exato', 'exato_uf', 'aproximado', 'fora_uf',
                                                         'fora_cep', 'fora_brasil', 'sem_uf', 'conflito_uf',
                                                         'sem_match', 'manual')),
        confianca        TEXT CHECK (confianca IN ('alta', 'media', 'manual')),
        distancia        INTEGER,
        amostra_original TEXT,
        criado_em        TEXT NOT NULL,
        usuario_id       INTEGER REFERENCES usuarios(id),
        UNIQUE (cidade_norm, uf_norm)
      );
      ALTER TABLE matriculas ADD COLUMN aluno_estado        TEXT;    -- students.state, só trim
      ALTER TABLE matriculas ADD COLUMN aluno_cep           TEXT;    -- students.cep, só dígitos
      ALTER TABLE matriculas ADD COLUMN codigo_ibge         INTEGER REFERENCES municipios(codigo_ibge);
      ALTER TABLE matriculas ADD COLUMN municipio_metodo    TEXT;    -- cópia do apelido que resolveu
      ALTER TABLE matriculas ADD COLUMN municipio_confianca TEXT;
      CREATE INDEX idx_matriculas_municipio ON matriculas(codigo_ibge, criada_em);
      INSERT INTO configuracoes (chave, valor) VALUES ('sync_completo_pendente', '1')
        ON CONFLICT(chave) DO UPDATE SET valor = '1';
    `);
  },

  // 19 — UF normalizada do aluno na matrícula (sigla vinda de state, do
  // sufixo da cidade ou da faixa de CEP — agora com a tabela de faixas de
  // TODAS as UFs), para agregar "outros estados" por UF em SQL puro.
  // territorio_recruzar_pendente faz o boot reprocessar o casamento uma vez
  // (preenche aluno_uf das matrículas já casadas sem esperar o próximo sync).
  () => {
    db.exec(`
      ALTER TABLE matriculas ADD COLUMN aluno_uf TEXT;
      INSERT INTO configuracoes (chave, valor) VALUES ('territorio_recruzar_pendente', '1')
        ON CONFLICT(chave) DO UPDATE SET valor = '1';
    `);
  },

  // 20 — Prospecção ativa (2026-09-09): as planilhas de carteiras por setor
  // (ATIVOS PARANÁ / ATIVO SANTA CATARINA) entram no jonIAs, que vira o lugar
  // oficial do controle. `importacoes` é recriada para aceitar tipo
  // 'prospeccao' (SQLite não altera CHECK); ligacoes/oportunidades/matriculas
  // apontam para importacoes(id), então a migração roda com foreign_keys OFF
  // (receita oficial do SQLite para recriar tabela referenciada — `desligarFk`
  // é tratado pelo runner, que confere `foreign_key_check` ao fim) — os ids
  // são preservados na cópia.
  // cores_prospeccao: 1 linha por cor de preenchimento distinta (RGB já com
  // tema+tint resolvidos); nome/significado são dados pelo usuário na tela
  // /prospeccao — cor É informação (status), nunca inventada pelo sistema.
  // contatos_ativo: 1 linha por linha da planilha, chave (uf, aba, nº da
  // linha); tudo preservado (originais, extras, cor por célula, oculta).
  Object.assign(() => {
    db.exec(`
      CREATE TABLE importacoes_nova (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo                  TEXT    NOT NULL CHECK (tipo IN ('cdr','oportunidades','mysql','prospeccao')),
        arquivo_nome          TEXT,
        hash_sha256           TEXT,
        linhas_lidas          INTEGER NOT NULL DEFAULT 0,
        linhas_validas        INTEGER NOT NULL DEFAULT 0,
        linhas_ignoradas      INTEGER NOT NULL DEFAULT 0,
        registros_novos       INTEGER NOT NULL DEFAULT 0,
        registros_atualizados INTEGER NOT NULL DEFAULT 0,
        detalhes_json         TEXT    NOT NULL DEFAULT '{}',
        status                TEXT    NOT NULL DEFAULT 'concluida' CHECK (status IN ('concluida','erro')),
        erro                  TEXT,
        usuario_id            INTEGER NOT NULL REFERENCES usuarios(id),
        iniciado_em           TEXT    NOT NULL,
        concluido_em          TEXT,
        registros_identicos   INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO importacoes_nova (id, tipo, arquivo_nome, hash_sha256, linhas_lidas, linhas_validas,
        linhas_ignoradas, registros_novos, registros_atualizados, detalhes_json, status, erro,
        usuario_id, iniciado_em, concluido_em, registros_identicos)
      SELECT id, tipo, arquivo_nome, hash_sha256, linhas_lidas, linhas_validas, linhas_ignoradas,
        registros_novos, registros_atualizados, detalhes_json, status, erro, usuario_id, iniciado_em,
        concluido_em, registros_identicos FROM importacoes;
      DROP TABLE importacoes;
      ALTER TABLE importacoes_nova RENAME TO importacoes;
      CREATE INDEX idx_importacoes_tipo ON importacoes(tipo, iniciado_em);
      CREATE INDEX idx_importacoes_hash ON importacoes(hash_sha256);

      CREATE TABLE cores_prospeccao (
        cor_hex       TEXT PRIMARY KEY,               -- 'FF0000' (6 hex, sem alpha)
        origem        TEXT,                           -- 'argb' | 'tema N tint T' | 'indexada N'
        linhas        INTEGER NOT NULL DEFAULT 0,     -- linhas cuja cor dominante é esta
        celulas       INTEGER NOT NULL DEFAULT 0,     -- células isoladas (cor ≠ cor da linha)
        status_nome   TEXT,                           -- dado pelo usuário; NULL = sem nome ainda
        significado   TEXT,
        ignorar       INTEGER NOT NULL DEFAULT 0,     -- 1 = só formatação, não é status
        ordem         INTEGER,
        atualizado_em TEXT,
        usuario_id    INTEGER REFERENCES usuarios(id)
      );
      CREATE TABLE contatos_ativo (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        uf                  TEXT    NOT NULL,
        setor               TEXT    NOT NULL,          -- nome da aba, verbatim
        linha_origem        INTEGER NOT NULL,          -- nº da linha na aba
        arquivo_nome        TEXT,
        importacao_id       INTEGER REFERENCES importacoes(id),
        orgao               TEXT,                      -- 'PM' | 'CM' | 'Autarquia' | NULL (derivado da aba)
        municipio_texto     TEXT,
        codigo_ibge         INTEGER REFERENCES municipios(codigo_ibge),
        municipio_metodo    TEXT,
        municipio_confianca TEXT,
        telefone_original   TEXT,
        telefone            TEXT,                      -- só dígitos
        telefone_valido     INTEGER,                   -- 1 = 10–11 dígitos; 0 = tem algo mas inválido; NULL = vazio
        whatsapp_original   TEXT,
        whatsapp            TEXT,
        responsavel         TEXT,
        cargo               TEXT,
        email               TEXT,
        data_ultimo_contato TEXT,                      -- ISO (YYYY-MM-DD)
        observacoes         TEXT,
        consultor_planilha  TEXT,
        cor_linha           TEXT REFERENCES cores_prospeccao(cor_hex),
        cores_celulas_json  TEXT,                      -- {campo: hex} onde a célula difere da linha
        linha_oculta        INTEGER NOT NULL DEFAULT 0,
        extras_json         TEXT,                      -- colunas não mapeadas + valores não parseáveis
        criado_em           TEXT    NOT NULL,
        atualizado_em       TEXT,
        editado_em          TEXT,                      -- edição feita no jonIAs (bloqueia reimportação da aba)
        UNIQUE (uf, setor, linha_origem)
      );
      CREATE INDEX idx_contatos_municipio ON contatos_ativo(codigo_ibge);
      CREATE INDEX idx_contatos_setor ON contatos_ativo(uf, setor);
      CREATE INDEX idx_contatos_telefone ON contatos_ativo(telefone);
      CREATE INDEX idx_contatos_cor ON contatos_ativo(cor_linha);
    `);
  }, { desligarFk: true }),

  // 21 — Prospecção: colunas promovidas de extras a campo (decisão do usuário,
  // 2026-09-09): curso; "contato inexistente"/"tel inexistente" vira um FLAG de
  // status (contato_inexistente = 1, com o texto original em
  // contato_inexistente_texto — "telefone não funciona", "só chama"…) que
  // prevalece sobre o status da cor; "Cadastro no CRM?" vira booleano
  // (Sim/Não; outro texto fica em extras).
  () => {
    db.exec(`
      ALTER TABLE contatos_ativo ADD COLUMN curso TEXT;
      ALTER TABLE contatos_ativo ADD COLUMN contato_inexistente INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE contatos_ativo ADD COLUMN contato_inexistente_texto TEXT;
      ALTER TABLE contatos_ativo ADD COLUMN cadastro_crm INTEGER;
    `);
  },

  // 22 — Prospecção, Fase 2 (tela de trabalho, 2026-09-09): consultor atual
  // por pessoa_id (decisão do usuário: só Frederico, Renato, Eduardo, Agnes e
  // Bianca; toda outra grafia fica sem consultor — o texto segue em
  // consultor_planilha), quem editou, origem da linha (planilha | manual) e o
  // histórico de contatos/edições por linha. "Fred" entra como grafia do
  // Frederico (625 linhas da planilha).
  () => {
    db.exec(`
      ALTER TABLE contatos_ativo ADD COLUMN pessoa_id   INTEGER REFERENCES pessoas(id);
      ALTER TABLE contatos_ativo ADD COLUMN editado_por INTEGER REFERENCES usuarios(id);
      ALTER TABLE contatos_ativo ADD COLUMN origem      TEXT NOT NULL DEFAULT 'planilha';
      CREATE INDEX idx_contatos_pessoa ON contatos_ativo(pessoa_id);
      CREATE INDEX idx_contatos_data   ON contatos_ativo(data_ultimo_contato);
      CREATE TABLE contatos_ativo_historico (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        contato_id     INTEGER NOT NULL REFERENCES contatos_ativo(id) ON DELETE CASCADE,
        tipo           TEXT    NOT NULL CHECK (tipo IN ('contato', 'edicao', 'status', 'criacao')),
        canal          TEXT    CHECK (canal IN ('ligacao', 'whatsapp', 'email', 'visita', 'outro')),
        campo          TEXT,
        valor_anterior TEXT,
        valor_novo     TEXT,
        observacao     TEXT,
        usuario_id     INTEGER NOT NULL REFERENCES usuarios(id),
        registrado_em  TEXT    NOT NULL
      );
      CREATE INDEX idx_historico_contato ON contatos_ativo_historico(contato_id, registrado_em);
    `);
    const fred = db.prepare("SELECT id, nomes_alternativos FROM pessoas WHERE nome = 'Frederico'").get();
    if (fred) {
      const alts = JSON.parse(fred.nomes_alternativos || "[]");
      if (!alts.includes("Fred")) {
        db.prepare("UPDATE pessoas SET nomes_alternativos = ? WHERE id = ?").run(JSON.stringify([...alts, "Fred"]), fred.id);
      }
    }
    // Backfill restrito: nome normalizado da planilha = nome/grafia de um dos 5
    const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const mapa = new Map();
    for (const p of db.prepare("SELECT id, nome, wallet_nome, nomes_alternativos FROM pessoas WHERE nome IN ('Frederico','Renato','Eduardo','Agnes','Bianca')").all()) {
      for (const n of [p.nome, p.wallet_nome, ...JSON.parse(p.nomes_alternativos || "[]")]) if (n) mapa.set(norm(n), p.id);
    }
    let casados = 0;
    const atualizar = db.prepare("UPDATE contatos_ativo SET pessoa_id = ? WHERE lower(trim(consultor_planilha)) = ?");
    for (const r of db.prepare("SELECT DISTINCT consultor_planilha c FROM contatos_ativo WHERE consultor_planilha IS NOT NULL").all()) {
      const id = mapa.get(norm(r.c));
      if (id) casados += atualizar.run(id, String(r.c).trim().toLowerCase()).changes;
    }
    console.log(`migração 22: ${casados} contato(s) com consultor atual atribuído (5 nomes); os demais ficam sem consultor.`);
  },

  // 23 — Prospecção, Fase 3 (2026-09-09): papel 'vendedor' com escopo por
  // regional. usuarios ganha pessoa_id (login ↔ consultor), senha_temporaria
  // (troca obrigatória no 1º acesso), senha_trocada_em e ultimo_acesso_em.
  // `papel` continua sem CHECK (recriar usuarios exigiria desligar FK de 8
  // tabelas) — a validação admin|vendedor é feita no código. carteiras:
  // regional ↔ vendedor, N:N com no máximo UM titular por regional (índice
  // parcial); ao definir o titular, os contatos sem consultor da regional
  // passam para ele (decisão do usuário) — feito na rota, com histórico.
  () => {
    db.exec(`
      ALTER TABLE usuarios ADD COLUMN pessoa_id        INTEGER REFERENCES pessoas(id);
      ALTER TABLE usuarios ADD COLUMN senha_temporaria INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usuarios ADD COLUMN senha_trocada_em TEXT;
      ALTER TABLE usuarios ADD COLUMN ultimo_acesso_em TEXT;
      CREATE UNIQUE INDEX idx_usuarios_pessoa ON usuarios(pessoa_id) WHERE pessoa_id IS NOT NULL;
      CREATE TABLE carteiras (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        regional_id INTEGER NOT NULL REFERENCES regionais(id),
        pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id),
        papel       TEXT    NOT NULL CHECK (papel IN ('titular', 'apoio')),
        criado_em   TEXT    NOT NULL,
        usuario_id  INTEGER REFERENCES usuarios(id),
        UNIQUE (regional_id, pessoa_id)
      );
      CREATE UNIQUE INDEX idx_carteiras_titular ON carteiras(regional_id) WHERE papel = 'titular';
      CREATE INDEX idx_carteiras_pessoa ON carteiras(pessoa_id);
    `);
  },

  // 24 — Prospecção, Fase 4 (2026-09-10): cruzamento do CDR com a prospecção,
  // o Omie e as matrículas (cruzamento.js). Colunas DERIVADAS em ligacoes,
  // recalculáveis a qualquer momento: numero_externo (dígitos normalizados),
  // classe (interna | prospeccao | ambigua | cliente | lead | desconhecida),
  // codigo_ibge (município da prospecção — o telefone da prefeitura é
  // compartilhado por dezenas de setores, então o elo confiável é ligação →
  // município), contato_id (só quando o número é único), oportunidade_id e
  // matricula_id (preenchidos sempre que batem). Decisões do usuário: número
  // em 2 municípios = 'ambigua' (não conta, fica para revisão); o cruzamento
  // é SÓ LEITURA — nunca altera data_ultimo_contato nem o histórico. A marca
  // cdr_cruzar_pendente faz o boot cruzar tudo uma vez (cruzarSePendente).
  () => {
    db.exec(`
      ALTER TABLE ligacoes ADD COLUMN numero_externo    TEXT;
      ALTER TABLE ligacoes ADD COLUMN classe            TEXT CHECK (classe IN ('interna', 'prospeccao', 'ambigua', 'cliente', 'lead', 'desconhecida'));
      ALTER TABLE ligacoes ADD COLUMN codigo_ibge       INTEGER REFERENCES municipios(codigo_ibge);
      ALTER TABLE ligacoes ADD COLUMN contato_id        INTEGER REFERENCES contatos_ativo(id);
      ALTER TABLE ligacoes ADD COLUMN oportunidade_id   INTEGER REFERENCES oportunidades(id);
      ALTER TABLE ligacoes ADD COLUMN matricula_id      INTEGER REFERENCES matriculas(id);
      ALTER TABLE ligacoes ADD COLUMN cruzamento_metodo TEXT;
      ALTER TABLE ligacoes ADD COLUMN cruzado_em        TEXT;
      CREATE INDEX idx_ligacoes_classe_municipio ON ligacoes(classe, codigo_ibge, data_hora);
      CREATE INDEX idx_ligacoes_numero_externo   ON ligacoes(numero_externo);
      CREATE INDEX idx_ligacoes_contato          ON ligacoes(contato_id);
      INSERT INTO configuracoes (chave, valor) VALUES ('cdr_cruzar_pendente', '1')
        ON CONFLICT(chave) DO UPDATE SET valor = '1';
    `);
  },

  // 25 — Marcação pessoal da prospecção (2026-09-16). Camada visual separada
  // do status importado (cor_linha) e do registro de contato: cada usuário
  // pinta a linha de verde ou vermelho para si mesmo. Uma linha por
  // (usuário, contato); sem marcação = sem linha. Não mexe em editado_em nem
  // no histórico — não bloqueia reimportação e não é edição do contato.
  () => {
    db.exec(`
      CREATE TABLE marcacoes_prospeccao (
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        contato_id  INTEGER NOT NULL REFERENCES contatos_ativo(id) ON DELETE CASCADE,
        cor         TEXT NOT NULL CHECK (cor IN ('verde', 'vermelho')),
        marcado_em  TEXT NOT NULL,
        PRIMARY KEY (usuario_id, contato_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_marcacoes_contato ON marcacoes_prospeccao(contato_id);
    `);
  },

  // 26 — Vendedor novo Jhonnata e ramal 2004 COM vigência (decisão do
  // usuário, 2026-09-25). Diferente do 2001 (migração 17, consolidado no
  // Eduardo sem vigência): o 2004 tem 1.411 ligações do Douglas desde
  // 01/12/2025 em produção, então o histórico fica com quem ligou. Até
  // 2026-09-21 o ramal é do Douglas; a partir de 2026-09-22 (entrada do
  // Jhonnata), do Jhonnata.
  // - `ramal_vigencias` guarda o dono do ramal por período e é consultada pelo
  //   importador do CDR ANTES de `pessoas.ramal`. Sem isso, reimportar um CSV
  //   antigo devolveria as ligações do Douglas ao dono atual (o upsert refaz
  //   pessoa_id). Ramal sem linha aqui segue a regra de sempre (pessoas.ramal).
  // - Douglas fica sem ramal em `pessoas` e continua em OCULTOS_TEMPORARIOS_TV.
  // - Só muda de dono o que é do Jhonnata pela vigência (data_hora ≥
  //   2026-09-22); o número sai no log. Nada é apagado.
  // - Gerencial ganha a grafia "Paulo Sergio Orfanelli" (2 oportunidades do
  //   Omie sem match em 2026-09-25).
  // - Backfills só onde pessoa_id IS NULL (mesmo padrão da migração 17).
  () => {
    db.exec(`
      CREATE TABLE ramal_vigencias (
        id            INTEGER PRIMARY KEY,
        ramal         TEXT NOT NULL,
        pessoa_id     INTEGER NOT NULL REFERENCES pessoas(id),
        vigente_desde TEXT,          -- NULL = desde sempre
        vigente_ate   TEXT,          -- NULL = em aberto (datas locais AAAA-MM-DD, inclusivas)
        UNIQUE (ramal, vigente_desde)
      );
    `);
    const douglas = db.prepare("SELECT id FROM pessoas WHERE nome = 'Douglas' AND tipo = 'consultor'").get()?.id;
    if (!douglas) throw new Error("migração 26: consultor Douglas não encontrado — abortada");
    db.prepare("UPDATE pessoas SET ramal = NULL WHERE id = ?").run(douglas);
    const jhonnata = db
      .prepare(
        `INSERT INTO pessoas (nome, ramal, crm_user_id, wallet_nome, ativo, entra_feedback,
                              tipo, entra_painel, entra_tv, nomes_alternativos)
         VALUES ('Jhonnata', '2004', 55622, 'Jhonnata', 1, 1, 'consultor', 1, 1, json(?))`
      )
      .run(JSON.stringify(NOMES_JHONNATA)).lastInsertRowid;
    const vigencia = db.prepare("INSERT INTO ramal_vigencias (ramal, pessoa_id, vigente_desde, vigente_ate) VALUES (?, ?, ?, ?)");
    vigencia.run("2004", douglas, null, "2026-09-21");
    vigencia.run("2004", jhonnata, "2026-09-22", null);

    const doJhonnata = db
      .prepare("UPDATE ligacoes SET pessoa_id = ? WHERE ramal = '2004' AND data_hora >= '2026-09-22' AND (pessoa_id IS NULL OR pessoa_id != ?)")
      .run(jhonnata, jhonnata).changes;
    const doDouglas = db
      .prepare("SELECT COUNT(*) n FROM ligacoes WHERE ramal = '2004' AND pessoa_id = ?")
      .get(douglas).n;
    console.log(`migração 26: ramal 2004 com vigência — ${doJhonnata} ligação(ões) desde 22/09/2026 passaram ao Jhonnata; ${doDouglas} seguem do Douglas.`);

    const nomes = NOMES_JHONNATA.map((n) => n.toLowerCase());
    const marcadores = nomes.map(() => "?").join(", ");
    const mat = db
      .prepare(`UPDATE matriculas SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(wallet)) IN (${marcadores})`)
      .run(jhonnata, ...nomes).changes;
    const opo = db
      .prepare(`UPDATE oportunidades SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(vendedor)) IN (${marcadores})`)
      .run(jhonnata, ...nomes).changes;
    console.log(`migração 26: backfill Jhonnata — ${mat} matrícula(s), ${opo} oportunidade(s).`);

    const gerencial = db.prepare("SELECT id, nomes_alternativos FROM pessoas WHERE nome = 'Gerencial'").get();
    if (gerencial) {
      const alts = JSON.parse(gerencial.nomes_alternativos || "[]");
      if (!alts.includes("Paulo Sergio Orfanelli")) alts.push("Paulo Sergio Orfanelli");
      db.prepare("UPDATE pessoas SET nomes_alternativos = ? WHERE id = ?").run(JSON.stringify(alts), gerencial.id);
      const g = db
        .prepare("UPDATE oportunidades SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(vendedor)) = 'paulo sergio orfanelli'")
        .run(gerencial.id).changes;
      console.log(`migração 26: Gerencial ganhou "Paulo Sergio Orfanelli" — ${g} oportunidade(s) atribuída(s).`);
    }
  },

  // 27 — Marcação pessoal AMARELA (decisão do usuário, 2026-09-25). O SQLite
  // não altera CHECK: a tabela é recriada e TODAS as linhas copiadas. Antes do
  // commit, total e contagem por cor da tabela nova têm de ser iguais aos da
  // antiga — senão a migração aborta e nada muda. Nenhuma outra tabela
  // referencia marcacoes_prospeccao (dispensa desligarFk).
  () => {
    const contar = (tabela) =>
      JSON.stringify(db.prepare(`SELECT cor, COUNT(*) n FROM ${tabela} GROUP BY cor ORDER BY cor`).all());
    const antes = contar("marcacoes_prospeccao");
    db.exec(`
      CREATE TABLE marcacoes_prospeccao_nova (
        usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        contato_id  INTEGER NOT NULL REFERENCES contatos_ativo(id) ON DELETE CASCADE,
        cor         TEXT NOT NULL CHECK (cor IN ('verde', 'vermelho', 'amarelo')),
        marcado_em  TEXT NOT NULL,
        PRIMARY KEY (usuario_id, contato_id)
      ) WITHOUT ROWID;
      INSERT INTO marcacoes_prospeccao_nova (usuario_id, contato_id, cor, marcado_em)
        SELECT usuario_id, contato_id, cor, marcado_em FROM marcacoes_prospeccao;
    `);
    const depois = contar("marcacoes_prospeccao_nova");
    if (antes !== depois) throw new Error(`migração 27: contagem das marcações divergiu (${antes} → ${depois}) — abortada`);
    db.exec(`
      DROP TABLE marcacoes_prospeccao;
      ALTER TABLE marcacoes_prospeccao_nova RENAME TO marcacoes_prospeccao;
      CREATE INDEX idx_marcacoes_contato ON marcacoes_prospeccao(contato_id);
    `);
    console.log(`migração 27: marcação amarela liberada — marcações preservadas: ${antes}`);
  },

  // 28 — ROTA: lista diária de ligações por consultor (decisões do usuário,
  // 2026-09-30; módulo rota.js). A rota é uma CAMPANHA POR SETOR: o admin
  // escolhe o tipo (conjunto de abas/setores) e todas as rotas geradas a
  // partir de `vale_desde` são daquele setor — nunca mistura setores.
  // - rota_tipos: setores_json = [{uf, setor}] com os nomes EXATOS das abas;
  //   cota = itens por dia. Configurável na tela, sem mexer no código.
  // - rota_campanhas: histórico das trocas; vigente numa data = a de
  //   vale_desde mais recente ≤ data; tipo_id NULL = campanha encerrada.
  // - rotas: uma por consultor por dia; gerada, NÃO muda (elegiveis = estoque
  //   do consultor no momento da geração — rota curta fica explicada).
  // - rota_itens: o histórico de rota. Nunca é apagado (exceto rota futura
  //   descartada pelo admin antes de começar); o bloqueio por TELEFONE de 30
  //   dias (ligado/baixa) e 7 dias (entrou e não foi ligado) sai daqui + CDR +
  //   registros manuais. `telefone` = número no momento da geração.
  // Seed: tipo "Licitação" com os 6 setores aprovados; nenhuma campanha
  // vigente — o admin liga a primeira na tela.
  () => {
    db.exec(`
      CREATE TABLE rota_tipos (
        id            INTEGER PRIMARY KEY,
        nome          TEXT NOT NULL UNIQUE,
        setores_json  TEXT NOT NULL,
        cota          INTEGER NOT NULL DEFAULT 45 CHECK (cota BETWEEN 1 AND 500),
        ativo         INTEGER NOT NULL DEFAULT 1,
        criado_em     TEXT NOT NULL,
        atualizado_em TEXT,
        usuario_id    INTEGER REFERENCES usuarios(id)
      );
      CREATE TABLE rota_campanhas (
        id          INTEGER PRIMARY KEY,
        tipo_id     INTEGER REFERENCES rota_tipos(id),   -- NULL = sem campanha
        vale_desde  TEXT NOT NULL,                        -- AAAA-MM-DD (horário de Brasília)
        criada_em   TEXT NOT NULL,
        usuario_id  INTEGER REFERENCES usuarios(id)
      );
      CREATE INDEX idx_rota_campanhas_data ON rota_campanhas(vale_desde);
      CREATE TABLE rotas (
        id          INTEGER PRIMARY KEY,
        pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id),
        data        TEXT NOT NULL,
        campanha_id INTEGER NOT NULL REFERENCES rota_campanhas(id),
        tipo_id     INTEGER NOT NULL REFERENCES rota_tipos(id),
        setores_json TEXT NOT NULL,                       -- setores do tipo NA geração
        cota        INTEGER NOT NULL,
        elegiveis   INTEGER NOT NULL,
        gerada_em   TEXT NOT NULL,
        gerada_por  INTEGER REFERENCES usuarios(id),      -- NULL = automática (17h)
        UNIQUE (pessoa_id, data)
      );
      CREATE INDEX idx_rotas_data ON rotas(data);
      CREATE TABLE rota_itens (
        id               INTEGER PRIMARY KEY,
        rota_id          INTEGER NOT NULL REFERENCES rotas(id) ON DELETE CASCADE,
        contato_id       INTEGER NOT NULL REFERENCES contatos_ativo(id),
        posicao          INTEGER NOT NULL,
        telefone         TEXT NOT NULL,
        setor            TEXT NOT NULL,
        codigo_ibge      INTEGER,
        baixa_em         TEXT,
        baixa_metodo     TEXT CHECK (baixa_metodo IN ('cdr', 'manual')),
        ligacao_id       INTEGER REFERENCES ligacoes(id),
        atendida         INTEGER,
        baixa_usuario_id INTEGER REFERENCES usuarios(id),
        UNIQUE (rota_id, contato_id)
      );
      CREATE INDEX idx_rota_itens_telefone ON rota_itens(telefone);
      CREATE INDEX idx_rota_itens_contato ON rota_itens(contato_id);
    `);
    const licitacao = [
      { uf: "PR", setor: "LICITAÇÃO PM" },
      { uf: "PR", setor: "LICITAÇÃO CM" },
      { uf: "PR", setor: "LICITAÇÃO PM - com população" },
      { uf: "PR", setor: "Licitação CM com Papulação" },
      { uf: "SC", setor: "LICITAÇÃO PM" },
      { uf: "SC", setor: "LICITAÇÃO CM" },
    ];
    db.prepare("INSERT INTO rota_tipos (nome, setores_json, cota, criado_em) VALUES ('Licitação', ?, 45, ?)")
      .run(JSON.stringify(licitacao), new Date().toISOString());
    console.log("migração 28: rota criada — tipo \"Licitação\" (6 setores, 45/dia); nenhuma campanha vigente até o admin ligar.");
  },

  // 29 — Meta de PIPELINE substitui a de leads (decisões do usuário,
  // 2026-10-02). Pipeline do dia = Σ ticket ATUAL das oportunidades com
  // fase_01_em no dia (ticket zero soma zero; ticket preenchido depois só é
  // sinalizado, não descontado). `pipeline_dia` em centavos, padrão
  // R$ 8.400 a partir de 2026-10-05; semana e mês saem × dias úteis.
  // As metas de leads (dia e mês, padrão e próprias) são ENCERRADAS em
  // 2026-10-04 — nada é apagado: período anterior continua com a meta que
  // valia. Linha de leads que começaria depois do corte (não deveria existir)
  // é só listada no log. O SQLite não altera CHECK: a tabela é recriada.
  () => {
    const antes = db.prepare("SELECT COUNT(*) n FROM metas").get().n;
    db.exec(`
      CREATE TABLE metas_nova (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        indicador     TEXT    NOT NULL CHECK (indicador IN (
                        'ligacoes_dia', 'leads_dia', 'matriculas_dia', 'receita_dia', 'pipeline_dia',
                        'receita_semana',
                        'ligacoes_mes', 'leads_mes', 'matriculas_mes', 'receita_mes',
                        'receita_semana_equipe', 'receita_mes_equipe')),
        valor         REAL    NOT NULL,
        vigente_desde TEXT    NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (indicador, pessoa_id, vigente_desde)
      );
      INSERT INTO metas_nova (id, pessoa_id, indicador, valor, vigente_desde, vigente_ate)
        SELECT id, pessoa_id, indicador, valor, vigente_desde, vigente_ate FROM metas;
      DROP TABLE metas;
      ALTER TABLE metas_nova RENAME TO metas;
    `);
    const depois = db.prepare("SELECT COUNT(*) n FROM metas").get().n;
    if (depois !== antes) throw new Error(`migração 29: metas ${antes} → ${depois} — abortada`);
    const fechadas = db.prepare(
      `UPDATE metas SET vigente_ate = '2026-10-04'
       WHERE indicador IN ('leads_dia', 'leads_mes') AND vigente_desde <= '2026-10-04'
         AND (vigente_ate IS NULL OR vigente_ate > '2026-10-04')`
    ).run().changes;
    const futuras = db.prepare(
      "SELECT COUNT(*) n FROM metas WHERE indicador IN ('leads_dia', 'leads_mes') AND vigente_desde > '2026-10-04'"
    ).get().n;
    db.prepare("INSERT INTO metas (pessoa_id, indicador, valor, vigente_desde) VALUES (NULL, 'pipeline_dia', 840000, '2026-10-05')").run();
    console.log(
      `migração 29: ${depois} meta(s) preservadas; pipeline_dia = R$ 8.400 desde 05/10; ` +
      `${fechadas} meta(s) de leads encerradas em 04/10` +
      (futuras ? ` — ⚠ ${futuras} meta(s) de leads com início depois de 04/10 seguem valendo (conferir em /metas)` : "")
    );
  },

  // 30 — Jhonnata saiu da equipe; último dia 2026-10-02 (decisões do usuário,
  // 2026-10-05). NADA é apagado do histórico: oportunidades, matrículas,
  // ligações e rotas com baixa continuam dele, e ele continua `ativo = 1`
  // (os relatórios internos de outubro seguem com ele, como Hirlan/Douglas).
  // - Fora de painel, TV e feedback (flags 0; também em OCULTOS_TEMPORARIOS_TV).
  //   Hirlan e Douglas (já fora da TV) saem do feedback na mesma migração.
  // - Ramal 2004: a vigência dele fecha em 02/10 e o ramal fica sem dono
  //   (pessoas.ramal NULL, nenhuma vigência aberta). Ligação do 2004 a partir
  //   de 03/10 que estava com ele perde o dono — o importador faz o mesmo nas
  //   próximas importações.
  // - Carteira: os vínculos dele saem (fora das rotas). O log lista cada
  //   regional, quem continua nela e as que ficam sem titular ou sem ninguém,
  //   com contagem de contatos — a redistribuição é decisão do usuário em
  //   /usuarios (definir o titular atribui a ele os contatos sem consultor).
  // - Contatos com ele como consultor ficam SEM consultor, com histórico
  //   `pessoa_id` por contato, sem marcar editado_em (não é edição).
  // - Rotas dele de 03/10 em diante sem nenhuma baixa são descartadas: os
  //   telefones delas ficariam bloqueados 7 dias para os colegas.
  // - Usuário vendedor ligado a ele (se houver) é desativado.
  () => {
    const SAIDA = "2026-10-02";
    const jh = db.prepare("SELECT id FROM pessoas WHERE nome = 'Jhonnata' AND tipo = 'consultor'").get()?.id;
    if (!jh) throw new Error("migração 30: consultor Jhonnata não encontrado — abortada");
    db.prepare("UPDATE pessoas SET entra_painel = 0, entra_tv = 0, entra_feedback = 0, ramal = NULL WHERE id = ?").run(jh);
    // Hirlan e Douglas, fora da operação desde agosto, saem também do feedback
    // (decisão do usuário, 2026-10-05); o histórico segue nos relatórios internos
    const semFeedback = db.prepare(
      "UPDATE pessoas SET entra_feedback = 0 WHERE tipo = 'consultor' AND nome IN ('Hirlan', 'Douglas') AND entra_feedback = 1"
    ).run().changes;
    console.log(`migração 30: ${semFeedback} consultor(es) (Hirlan/Douglas) fora do feedback individual.`);

    const vig = db.prepare(
      "UPDATE ramal_vigencias SET vigente_ate = ? WHERE ramal = '2004' AND pessoa_id = ? AND (vigente_ate IS NULL OR vigente_ate > ?)"
    ).run(SAIDA, jh, SAIDA).changes;
    const ligs = db.prepare(
      "UPDATE ligacoes SET pessoa_id = NULL WHERE ramal = '2004' AND pessoa_id = ? AND data_hora >= ?"
    ).run(jh, "2026-10-03T00:00:00").changes;
    const ficam = db.prepare("SELECT COUNT(*) n FROM ligacoes WHERE pessoa_id = ?").get(jh).n;
    console.log(`migração 30: ramal 2004 — vigência do Jhonnata fechada em 02/10 (${vig}); ${ligs} ligação(ões) de 03/10 em diante ficaram sem dono; ${ficam} ligação(ões) seguem dele.`);

    // carteira: retrato antes de remover
    const contar = db.prepare(
      `SELECT COUNT(*) total, SUM(a.pessoa_id IS NULL) semConsultor, SUM(a.pessoa_id = ?) dele
       FROM contatos_ativo a JOIN municipios m ON m.codigo_ibge = a.codigo_ibge WHERE m.regional_principal_id = ?`
    );
    const vinculos = db.prepare(
      `SELECT c.regional_id id, c.papel, r.uf, r.sigla, r.nome FROM carteiras c JOIN regionais r ON r.id = c.regional_id
       WHERE c.pessoa_id = ? ORDER BY r.uf, r.sigla`
    ).all(jh);
    for (const v of vinculos) {
      const outros = db.prepare(
        `SELECT p.nome, c.papel FROM carteiras c JOIN pessoas p ON p.id = c.pessoa_id
         WHERE c.regional_id = ? AND c.pessoa_id <> ? ORDER BY c.papel DESC, p.nome`
      ).all(v.id, jh);
      const n = contar.get(jh, v.id);
      const titular = outros.find((o) => o.papel === "titular");
      const situacao = !outros.length ? "⚠ ÓRFÃ (ninguém)" : !titular ? `⚠ sem titular (apoio: ${outros.map((o) => o.nome).join(", ")})`
        : `fica com ${titular.nome}${outros.length > 1 ? ` + ${outros.filter((o) => o !== titular).map((o) => o.nome).join(", ")}` : ""}`;
      console.log(`migração 30: carteira ${v.uf} ${v.sigla} (${v.nome}) — Jhonnata era ${v.papel}; ${situacao}; ` +
        `${n.total} contato(s), ${n.dele || 0} dele, ${n.semConsultor || 0} sem consultor.`);
    }
    db.prepare("DELETE FROM carteiras WHERE pessoa_id = ?").run(jh);

    const agora = new Date().toISOString();
    const seus = db.prepare("SELECT id FROM contatos_ativo WHERE pessoa_id = ?").all(jh);
    const hist = db.prepare(
      `INSERT INTO contatos_ativo_historico (contato_id, tipo, canal, campo, valor_anterior, valor_novo, observacao, usuario_id, registrado_em)
       VALUES (?, 'edicao', NULL, 'pessoa_id', ?, NULL, 'liberado: Jhonnata saiu da equipe (último dia 02/10/2026, migração 30)', ?, ?)`
    );
    // o histórico exige usuário: a liberação fica no nome do primeiro admin (a observação diz que foi a migração)
    const admin = db.prepare("SELECT MIN(id) id FROM usuarios WHERE papel = 'admin'").get()?.id;
    if (seus.length && !admin) throw new Error("migração 30: nenhum admin para registrar o histórico — abortada");
    const liberar = db.prepare("UPDATE contatos_ativo SET pessoa_id = NULL, atualizado_em = ? WHERE id = ?");
    for (const { id } of seus) { liberar.run(agora, id); hist.run(id, String(jh), admin, agora); }

    const rotas = db.prepare(
      `DELETE FROM rotas WHERE pessoa_id = ? AND data > ?
         AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(jh, SAIDA).changes;
    const usuarios = db.prepare("UPDATE usuarios SET ativo = 0 WHERE pessoa_id = ? AND ativo = 1").run(jh).changes;
    console.log(`migração 30: Jhonnata fora de painel/TV/feedback/rotas — ${vinculos.length} vínculo(s) de carteira removido(s), ` +
      `${seus.length} contato(s) liberado(s) (sem consultor), ${rotas} rota(s) futura(s) sem baixa descartada(s), ${usuarios} usuário(s) desativado(s).`);
  },

  // 31 — FILA de setores na campanha da Rota (decisão do usuário,
  // 2026-10-05). A campanha deixa de ser um tipo só: `fila_json` = ids dos
  // tipos na ordem (tipo_id continua sendo o primeiro; NULL = encerrada). Cada
  // consultor começa no primeiro tipo com estoque e completa a cota com os
  // seguintes no mesmo dia; `rota_itens.tipo_id` diz de qual tipo veio cada
  // linha (o bloqueio por telefone é dentro do tipo DO ITEM). Backfill: as
  // campanhas viram fila de um tipo e os itens herdam o tipo da rota.
  () => {
    db.exec(`
      ALTER TABLE rota_campanhas ADD COLUMN fila_json TEXT;
      ALTER TABLE rota_itens ADD COLUMN tipo_id INTEGER REFERENCES rota_tipos(id);
    `);
    const camp = db.prepare("UPDATE rota_campanhas SET fila_json = json_array(tipo_id) WHERE tipo_id IS NOT NULL").run().changes;
    db.prepare("UPDATE rota_campanhas SET fila_json = '[]' WHERE tipo_id IS NULL").run();
    const itens = db.prepare("UPDATE rota_itens SET tipo_id = (SELECT r.tipo_id FROM rotas r WHERE r.id = rota_itens.rota_id)").run().changes;
    db.exec("CREATE INDEX idx_rota_itens_tipo ON rota_itens(tipo_id)");
    console.log(`migração 31: fila de setores na Rota — ${camp} campanha(s) viraram fila de um tipo; ${itens} item(ns) de rota com o tipo da rota.`);
  },

  // 32 — FILA CÍCLICA e as 7 campanhas por CURSO (decisões do usuário,
  // 2026-10-06). Com a regra da 31 (volta ao primeiro tipo com estoque) a
  // simulação em produção mostrou as campanhas 6 e 7 nunca alcançadas em dois
  // meses: o bloqueio de 30 dias da 1ª vence antes do fim da fila. Agora cada
  // consultor anda de 1 a 7 e só volta ao 1 depois do fim (ver gerarRotas).
  // Estado do ciclo gravado na própria rota (refazer a rota futura desfaz o
  // ponteiro junto): `ciclo` = volta no início do dia, `ponteiro_tipo_id` =
  // onde o dia seguinte começa, `ciclo_concluido` = a volta fechou nesta rota.
  // Rotas anteriores ficam com ciclo NULL (não contam volta).
  // Tipos: "Licitação" é RENOMEADO para "Licitação com IA" (mesmo id — o
  // bloqueio por telefone do que foi ligado desde 01/10 continua valendo) e
  // ganha as abas de compras/pregão/contratos; os outros 6 são criados. Aba
  // que não existir na base é mantida no tipo (não casa com contato nenhum) e
  // listada no log. A fila 1→7 vale no próximo dia útil; as rotas futuras que
  // ninguém começou são descartadas (como "refazer as rotas futuras" do painel).
  () => {
    db.exec(`
      ALTER TABLE rotas ADD COLUMN ciclo INTEGER;
      ALTER TABLE rotas ADD COLUMN ponteiro_tipo_id INTEGER REFERENCES rota_tipos(id);
      ALTER TABLE rotas ADD COLUMN ciclo_concluido INTEGER NOT NULL DEFAULT 0;
    `);
    const abas = (uf, lista) => lista.map((setor) => ({ uf, setor }));
    const CAMPANHAS = [
      ["Licitação com IA", [
        ...abas("PR", ["LICITAÇÃO PM", "LICITAÇÃO CM", "LICITAÇÃO PM - com população", "Licitação CM com Papulação"]),
        ...abas("SC", ["LICITAÇÃO PM", "LICITAÇÃO CM"]),
        ...abas("PR", ["Compras PM", "Compras CM"]), ...abas("SC", ["COMPRAS"]),
        ...abas("PR", ["PREGOEIRO"]), ...abas("SC", ["PREGOEIRO", "SAUDE LICITACAO"]),
        ...abas("PR", ["ETP E TR", "GESTOR E FISCAL DE CONTRATOS"]), ...abas("SC", ["Agente de contrataçãoFiscais"])]],
      ["Comunicação Pública 360º", [
        ...abas("PR", ["COMUNICAÇÃO PM", "COMUNICAÇÃO CM", "SECOM"]), ...abas("SC", ["COMUNICAÇÃO PM", "COMUNICAÇÃO CM"]),
        ...abas("PR", ["ASSESSOR PM", "ASSESSOR CM"]), ...abas("SC", ["ASSESSOR PM", "ASSESSOR CM"])]],
      // "Controle interno" é ESCOLHA FRACA (ver CLAUDE.md): sem ele a campanha não existe
      ["Portal e Ouvidoria", [
        ...abas("PR", ["TRANSPARENCIA PM", "Controle interno", "Controle Interno - CM"]),
        ...abas("SC", ["CONTROLE INTERNO PM", "CONTROLE INTERNO CM"])]],
      ["Patrimônio", [
        ...abas("PR", ["PATRIMONIO PM", "FROTAS E PATRIMONIO PM", "Patrimonio CM"]),
        ...abas("SC", ["PATRIMONIOFROTAS PM", "PATRIMONIOFROTAS CM"])]],
      ["Finanças", [
        ...abas("PR", ["FINANÇAS PM", "TESOURARIA PM", "TESOURARIA CM", "CONTABILIDADE PM", "CONTABILIDADE CM"]),
        ...abas("SC", ["TESOURARIA PM", "TESOURARIA CM", "CONTABILIDADE PM", "CONTABILIDADE CM"])]],
      ["Tributação Municipal", [...abas("PR", ["TRIBUTAÇÃO"]), ...abas("SC", ["PM TRIBUTAÇÃO"])]],
      // todas as abas CM; o público do curso primeiro (o contato escolhido
      // para cada telefone segue a ordem das abas — ~5 abas por número da câmara)
      ["IA na Câmara Municipal", [
        ...abas("PR", ["Legislativo CM", "Chefe de Gabinete CM", "ASSESSOR CM", "Servidores CM"]),
        ...abas("SC", ["LEGISLATIVO CM", "ASSESSOR CM"]),
        ...abas("PR", ["COMUNICAÇÃO CM", "CONTABILIDADE CM", "Compras CM", "Controle Interno - CM", "JURIDICO CM", "LICITAÇÃO CM",
          "Licitação CM com Papulação", "Patrimonio CM", "RH CM", "TESOURARIA CM"]),
        ...abas("SC", ["COMUNICAÇÃO CM", "CONTABILIDADE CM", "CONTROLE INTERNO CM", "JURIDICO CM", "LICITAÇÃO CM",
          "PATRIMONIOFROTAS CM", "RH CM", "TESOURARIA CM"])]],
    ];
    const existe = new Set(db.prepare("SELECT DISTINCT uf || '|' || setor k FROM contatos_ativo").all().map((r) => r.k));
    const agora = new Date().toISOString();
    const ids = [];
    for (const [nome, setores] of CAMPANHAS) {
      const faltam = setores.filter((s) => !existe.has(`${s.uf}|${s.setor}`));
      if (existe.size && faltam.length) console.warn(`⚠ migração 32: "${nome}" — aba(s) inexistente(s) na base: ${faltam.map((s) => `${s.uf} "${s.setor}"`).join(", ")}`);
      const atual = db.prepare("SELECT id FROM rota_tipos WHERE nome = ?").get(nome)
        ?? (nome === "Licitação com IA" ? db.prepare("SELECT id FROM rota_tipos WHERE nome = 'Licitação'").get() : null);
      if (atual) {
        db.prepare("UPDATE rota_tipos SET nome = ?, setores_json = ?, ativo = 1, atualizado_em = ? WHERE id = ?")
          .run(nome, JSON.stringify(setores), agora, atual.id);
        ids.push(atual.id);
      } else {
        ids.push(Number(db.prepare("INSERT INTO rota_tipos (nome, setores_json, cota, ativo, criado_em) VALUES (?, ?, 45, 1, ?)")
          .run(nome, JSON.stringify(setores), agora).lastInsertRowid));
      }
    }
    const cmFora = db.prepare("SELECT DISTINCT uf, setor FROM contatos_ativo WHERE orgao = 'CM'").all()
      .filter((r) => !CAMPANHAS[6][1].some((s) => s.uf === r.uf && s.setor === r.setor));
    if (cmFora.length) console.warn(`⚠ migração 32: aba(s) CM da base fora de "IA na Câmara Municipal": ${cmFora.map((s) => `${s.uf} "${s.setor}"`).join(", ")}`);

    // fila 1→7 no próximo dia útil (Brasília), descartando as rotas futuras sem baixa
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const descartadas = db.prepare(
      `DELETE FROM rotas WHERE data > ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(hoje).changes;
    const proximoUtil = (iso) => {
      const d = new Date(`${iso}T12:00:00Z`);
      do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
      return d.toISOString().slice(0, 10);
    };
    let vale = proximoUtil(hoje);
    while (db.prepare("SELECT 1 FROM rotas WHERE data = ? LIMIT 1").get(vale)) vale = proximoUtil(vale);
    db.prepare("DELETE FROM rota_campanhas WHERE vale_desde >= ? AND NOT EXISTS (SELECT 1 FROM rotas r WHERE r.campanha_id = rota_campanhas.id)").run(vale);
    db.prepare("INSERT INTO rota_campanhas (tipo_id, fila_json, vale_desde, criada_em) VALUES (?, ?, ?, ?)")
      .run(ids[0], JSON.stringify(ids), vale, agora);
    console.log(`migração 32: fila cíclica na Rota — tipos ${CAMPANHAS.map(([n], k) => `${k + 1}. ${n} (#${ids[k]})`).join(", ")}; ` +
      `fila 1→7 a partir de ${vale}; ${descartadas} rota(s) futura(s) sem baixa descartada(s).`);
  },

  // 33 — FERIADOS (decisão do usuário, 2026-10-27): dia útil = seg–sex fora
  // desta tabela, na Rota (não gera rota) e no motor de métricas (denominador
  // de meta, semana fechada da TV). Editável no painel da Rota (feriados.js).
  // Seed só com datas futuras (feriado passado mudaria relatórios fechados);
  // 15/11/2026 cai num domingo e não muda nada, mas fica registrado. 24/12 e
  // 31/12 ficam como dia útil (o usuário ajusta na mão se preciso).
  () => {
    db.exec(`
      CREATE TABLE feriados (
        data       TEXT PRIMARY KEY,
        nome       TEXT NOT NULL,
        criado_em  TEXT NOT NULL,
        usuario_id INTEGER REFERENCES usuarios(id)
      );
    `);
    const agora = new Date().toISOString();
    const ins = db.prepare("INSERT INTO feriados (data, nome, criado_em) VALUES (?, ?, ?)");
    const SEED = [
      ["2026-11-02", "Finados"],
      ["2026-11-15", "Proclamação da República"],
      ["2026-11-20", "Dia Nacional de Zumbi e da Consciência Negra"],
      ["2026-12-25", "Natal"],
      ["2027-01-01", "Confraternização Universal"],
    ];
    for (const [data, nome] of SEED) ins.run(data, nome, agora);
    // rota já gerada num desses dias e que ninguém começou: descartada
    const descartadas = db.prepare(
      `DELETE FROM rotas WHERE data IN (${SEED.map(() => "?").join(", ")})
         AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(...SEED.map(([d]) => d)).changes;
    console.log(`migração 33: feriados ${SEED.map(([d]) => d).join(", ")}; ${descartadas} rota(s) gerada(s) em feriado descartada(s).`);
  },
  // 34 — ROTA POR SETOR DE VENDEDOR (decisões do usuário, 2026-10-27): sem
  // regionais a partir de 03/11/2026. Cada vendedor ganha uma campanha PRÓPRIA
  // (rota_campanhas.pessoa_id, modo 'prioridade': o setor principal todo dia,
  // o complemento só quando falta estoque) e a geral é encerrada na mesma data.
  // Tipos novos (não herdam o bloqueio por telefone das campanhas de outubro —
  // só o por contato, regra T) com as TURMAS que cada um oferece. Abas casadas
  // por nome exato e, se não houver, por nome normalizado (acento/caixa/espaço);
  // aba inexistente vira aviso no log (ex.: "FINANÇAS PM" não existe em produção).
  () => {
    db.exec(`
      ALTER TABLE rota_tipos ADD COLUMN turmas_json TEXT;
      ALTER TABLE rota_campanhas ADD COLUMN pessoa_id INTEGER REFERENCES pessoas(id);
      ALTER TABLE rota_campanhas ADD COLUMN modo TEXT NOT NULL DEFAULT 'ciclica';
      CREATE INDEX idx_rota_campanhas_pessoa ON rota_campanhas(pessoa_id, vale_desde);
    `);
    const norm = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const existentes = db.prepare("SELECT DISTINCT uf, setor FROM contatos_ativo").all();
    const resolver = (uf, setor, tipo) => {
      const exato = existentes.find((x) => x.uf === uf && x.setor === setor);
      if (exato) return exato;
      const parecido = existentes.find((x) => x.uf === uf && norm(x.setor) === norm(setor));
      if (parecido) { console.warn(`⚠ migração 34: "${tipo}" — ${uf} "${setor}" casada com a aba "${parecido.setor}"`); return parecido; }
      if (existentes.length) console.warn(`⚠ migração 34: "${tipo}" — aba inexistente na base: ${uf} "${setor}" (fica de fora)`);
      return null;
    };
    const T = (curso, ...datas) => datas.map((data) => ({ curso, data }));
    const TURMAS = {
      Frederico: T("IA na Câmara Municipal", "2026-11-10", "2026-12-15"),
      Bianca: [...T("Patrimônio & Frotas", "2026-11-16"), ...T("Patrimônio Público com IA", "2026-12-08")],
      Renato: T("Comunicação Pública 360º", "2026-11-24", "2027-02-02"),
      Eduardo: [...T("Nova Era da Tesouraria", "2026-11-10"), ...T("Seminário Encerramento do Exercício Municipal", "2026-12-08")],
      Agnes: T("LICITAEXPO Blindagem nas Licitações", "2026-11-24"),
    };
    const PR = "PR", SC = "SC";
    // por vendedor: [tipo principal, complemento?], abas na ordem de preferência
    const PLANO = [
      ["Frederico", [["Legislativo", [
        [PR, "Legislativo CM"], [SC, "LEGISLATIVO CM"], [PR, "ASSESSOR CM"], [SC, "ASSESSOR CM"], [PR, "Servidores CM"],
        [PR, "Chefe de Gabinete CM"], [PR, "JURIDICO CM"], [SC, "JURIDICO CM"], [PR, "CONTABILIDADE CM"], [SC, "CONTABILIDADE CM"],
        [PR, "Patrimonio CM"], [SC, "PATRIMONIOFROTAS CM"], [PR, "Compras CM"], [PR, "COMUNICAÇÃO CM"], [SC, "COMUNICAÇÃO CM"],
        [PR, "Controle Interno - CM"], [SC, "CONTROLE INTERNO CM"], [PR, "TESOURARIA CM"], [SC, "TESOURARIA CM"], [PR, "RH CM"], [SC, "RH CM"]]]]],
      ["Bianca", [
        ["Patrimônio e Frotas", [[PR, "PATRIMONIO PM"], [PR, "FROTAS E PATRIMONIO PM"], [SC, "PATRIMONIOFROTAS PM"]]],
        ["Engenharia e Obras", [[PR, "Engenheiros"], [SC, "ENGENHEIROS"], [PR, "Obras e Urbanismo"], [SC, "OBRAS PM "]]]]],
      ["Renato", [
        ["Comunicação PM", [[PR, "COMUNICAÇÃO PM"], [SC, "COMUNICAÇÃO PM"], [PR, "SECOM"], [PR, "ASSESSOR PM"], [SC, "ASSESSOR PM"],
          [PR, "Gabinete PM"], [SC, "GABINETE PM"]]],
        ["Educação", [[PR, "Educação"]]]]],
      ["Eduardo", [
        ["Finanças PM", [[PR, "TESOURARIA PM"], [SC, "TESOURARIA PM"], [PR, "CONTABILIDADE PM"], [SC, "CONTABILIDADE PM"], [PR, "FINANÇAS PM"],
          [PR, "Planejamento"], [SC, "PLANEJAMENTO"]]],
        ["Controle Interno PM", [[PR, "Controle interno"], [SC, "CONTROLE INTERNO PM"]]]]],
      ["Agnes", [["Licitação PM e CM", [
        [PR, "LICITAÇÃO PM"], [SC, "LICITAÇÃO PM"], [PR, "LICITAÇÃO CM"], [SC, "LICITAÇÃO CM"], [PR, "PREGOEIRO"], [SC, "PREGOEIRO"],
        [PR, "Compras PM"], [PR, "ETP E TR"], [PR, "GESTOR E FISCAL DE CONTRATOS"], [PR, "LICITAÇÃO PM - com população"],
        [PR, "Licitação CM com Papulação"], [SC, "COMPRAS"], [SC, "SAUDE LICITACAO"], [SC, "Agente de contrataçãoFiscais"]]]]],
    ];

    // data em que passa a valer: 03/11/2026 ou, se a migração rodar depois, o
    // próximo dia útil (seg–sex fora dos feriados) — rotas futuras sem baixa
    // dessa data em diante são descartadas e geradas de novo
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const feriados = new Set(db.prepare("SELECT data FROM feriados").all().map((r) => r.data));
    const util = (iso) => { const w = new Date(`${iso}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5 && !feriados.has(iso); };
    const somar = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    let vale = "2026-11-03";
    if (vale <= hoje) { vale = somar(hoje, 1); while (!util(vale)) vale = somar(vale, 1); }

    const agora = new Date().toISOString();
    const nomesUsados = new Set(db.prepare("SELECT nome FROM rota_tipos").all().map((r) => r.nome));
    const criados = [];
    const campanhas = [];
    for (const [vendedor, tipos] of PLANO) {
      const pessoa = db.prepare("SELECT id FROM pessoas WHERE nome = ? AND tipo = 'consultor' AND ativo = 1").get(vendedor);
      if (!pessoa) { console.warn(`⚠ migração 34: consultor ativo "${vendedor}" não encontrado — sem campanha própria`); continue; }
      const ids = [];
      for (const [nomeBase, abas] of tipos) {
        const setores = abas.map(([uf, setor]) => resolver(uf, setor, nomeBase)).filter(Boolean).map((x) => ({ uf: x.uf, setor: x.setor }));
        if (!setores.length && existentes.length) { console.warn(`⚠ migração 34: "${nomeBase}" sem nenhuma aba — tipo não criado`); continue; }
        let nome = nomeBase;
        if (nomesUsados.has(nome)) nome = `${nomeBase} (${vendedor})`;
        nomesUsados.add(nome);
        const id = Number(db.prepare("INSERT INTO rota_tipos (nome, setores_json, cota, ativo, turmas_json, criado_em) VALUES (?, ?, 45, 1, ?, ?)")
          .run(nome, JSON.stringify(setores), JSON.stringify(TURMAS[vendedor]), agora).lastInsertRowid);
        ids.push(id);
        criados.push(`${nome} (#${id}, ${setores.length} aba(s))`);
      }
      if (!ids.length) continue;
      campanhas.push({ pessoaId: pessoa.id, vendedor, ids });
    }
    const descartadas = db.prepare(
      `DELETE FROM rotas WHERE data >= ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(vale).changes;
    db.prepare("DELETE FROM rota_campanhas WHERE vale_desde >= ? AND NOT EXISTS (SELECT 1 FROM rotas r WHERE r.campanha_id = rota_campanhas.id)").run(vale);
    const ins = db.prepare("INSERT INTO rota_campanhas (tipo_id, fila_json, vale_desde, criada_em, pessoa_id, modo) VALUES (?, ?, ?, ?, ?, ?)");
    for (const c of campanhas) ins.run(c.ids[0], JSON.stringify(c.ids), vale, agora, c.pessoaId, "prioridade");
    if (campanhas.length) ins.run(null, "[]", vale, agora, null, "ciclica"); // a geral (carteiras) encerra na mesma data
    console.log(`migração 34: rota por setor de vendedor a partir de ${vale} — tipos: ${criados.join(", ") || "nenhum"}; ` +
      `campanhas: ${campanhas.map((c) => `${c.vendedor} (${c.ids.length} tipo(s))`).join(", ") || "nenhuma"}; ` +
      `campanha geral encerrada em ${vale}; ${descartadas} rota(s) a partir de ${vale} sem baixa descartada(s).`);
  },
  // 35 — ROTA EXTRA (decisões do usuário, 2026-10-27): além da cota (45), mais
  // 15 itens OPCIONAIS no fim da rota (`rota_itens.extra = 1`; `rotas.extra` =
  // quantos a rota oferece). Não contam no progresso, na TV nem no prêmio — só
  // a favor. Extra sem baixa na hora da geração seguinte entra nas PRIMEIRAS
  // posições da rota do próximo dia, DENTRO das 45 (opção a), com
  // `origem_item_id` = o item extra de onde veio: a ligação feita no dia da
  // extra (CDR importado depois das 17h) também dá baixa nela. Sem REFERENCES no
  // origem: descartar uma rota não pode falhar por causa da cópia.
  () => {
    db.exec(`
      ALTER TABLE rota_itens ADD COLUMN extra INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rota_itens ADD COLUMN origem_item_id INTEGER;
      ALTER TABLE rotas ADD COLUMN extra INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_rota_itens_origem ON rota_itens(origem_item_id) WHERE origem_item_id IS NOT NULL;
    `);
    console.log("migração 35: Rota Extra — rota_itens.extra, rota_itens.origem_item_id, rotas.extra.");
  },
  // 36 — ROTA FINALIZAÇÃO DE ANO (decisões do usuário, 2026-11-10; plano
  // "Resumo_Rota Final_Unyflex.pdf"). Só ESTRUTURA — nada muda nas rotas até o
  // admin publicar o plano em /fim-de-ano (fimdeano.js):
  // - Danilo, vendedor novo (nome completo, ramal, wallet e Omie pendentes);
  // - faixas_vendedor: faixa ALFABÉTICA de município por vendedor e UF, com
  //   vigência TEMPORÁRIA 11/11–15/12 (em janeiro voltam as carteiras);
  // - contatos_ativo.entidade/cnpj/confirmar_antes (base de ÓRGÃOS NOVOS:
  //   consórcios, autarquias, RPPS — importados da planilha, origem
  //   'orgaos_novos');
  // - fim_ano_cursos: curso → tipo de rota (abas do setor), turma e janela de
  //   captação; tipos de rota NOVOS por curso (bloqueio por telefone não herda
  //   as rotas de outubro/novembro), + LicitaExpo (até 13/11), Turmas 2027
  //   (14–15/12) e "Órgãos novos" (bloco de 20, rota_itens.extra = 2);
  // - fim_ano_plano: vendedor × dia → tipo (curso do dia), rascunho até publicar.
  () => {
    db.exec(`
      ALTER TABLE contatos_ativo ADD COLUMN entidade TEXT;
      ALTER TABLE contatos_ativo ADD COLUMN cnpj TEXT;
      ALTER TABLE contatos_ativo ADD COLUMN confirmar_antes INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE faixas_vendedor (
        id            INTEGER PRIMARY KEY,
        pessoa_id     INTEGER NOT NULL REFERENCES pessoas(id),
        uf            TEXT NOT NULL,
        inicio        TEXT NOT NULL,
        fim           TEXT NOT NULL,
        vigente_desde TEXT NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (pessoa_id, uf, vigente_desde)
      );
      CREATE TABLE fim_ano_cursos (
        tipo_id       INTEGER PRIMARY KEY REFERENCES rota_tipos(id),
        curso         TEXT NOT NULL,
        setor         TEXT NOT NULL,
        turma         TEXT,
        captacao_de   TEXT NOT NULL,
        captacao_ate  TEXT NOT NULL,
        ordem         INTEGER NOT NULL,
        papel         TEXT NOT NULL DEFAULT 'curso' CHECK (papel IN ('curso', 'licitaexpo', '2027', 'novos'))
      );
      CREATE TABLE fim_ano_plano (
        pessoa_id     INTEGER NOT NULL REFERENCES pessoas(id),
        data          TEXT NOT NULL,
        tipo_id       INTEGER NOT NULL REFERENCES rota_tipos(id),
        manual        INTEGER NOT NULL DEFAULT 0,
        atualizado_em TEXT NOT NULL,
        usuario_id    INTEGER REFERENCES usuarios(id),
        PRIMARY KEY (pessoa_id, data)
      );
      CREATE INDEX idx_contatos_origem ON contatos_ativo(origem) WHERE origem <> 'planilha';
    `);
    if (!db.prepare("SELECT 1 FROM pessoas WHERE nome = 'Danilo'").get()) {
      db.prepare(
        `INSERT INTO pessoas (nome, ramal, ativo, entra_feedback, nomes_alternativos, tipo, entra_painel, entra_tv)
         VALUES ('Danilo', NULL, 1, 1, '[]', 'consultor', 1, 1)`).run();
    }
    const pid = (n) => db.prepare("SELECT id FROM pessoas WHERE nome = ? AND tipo = 'consultor'").get(n)?.id;
    const FAIXAS = [
      ["Frederico", "PR", "ABATIA", "COLOMBO"], ["Agnes", "PR", "COLORADO", "ITAMBE"], ["Eduardo", "PR", "ITAPEJARA DO OESTE", "NOVA OLIMPIA"],
      ["Bianca", "PR", "NOVA PRATA DO IGUACU", "SALTO DO ITARARE"], ["Danilo", "PR", "SALTO DO LONTRA", "XAMBRE"],
      ["Frederico", "SC", "Abdon Batista", "Canelinha"], ["Agnes", "SC", "Canoinhas", "Ipira"], ["Eduardo", "SC", "Iporã do Oeste", "Orleans"],
      ["Bianca", "SC", "Otacílio Costa", "Santiago do Sul"], ["Danilo", "SC", "Santo Amaro da Imperatriz", "Zortéa"],
    ];
    const insFaixa = db.prepare("INSERT INTO faixas_vendedor (pessoa_id, uf, inicio, fim, vigente_desde, vigente_ate) VALUES (?, ?, ?, ?, '2026-11-11', '2026-12-15')");
    for (const [n, uf, ini, fim] of FAIXAS) {
      if (pid(n)) insFaixa.run(pid(n), uf, ini, fim);
      else console.warn(`⚠ migração 36: consultor "${n}" não encontrado — faixa ${uf} ${ini} → ${fim} não gravada`);
    }

    // abas por setor (decisões do usuário, 2026-11-10), por nome exato e, se
    // não houver, normalizado; aba inexistente = aviso no log
    const norm = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const existentes = db.prepare("SELECT DISTINCT uf, setor FROM contatos_ativo").all();
    const resolver = (uf, setor) => existentes.find((x) => x.uf === uf && x.setor === setor) ||
      existentes.find((x) => x.uf === uf && norm(x.setor) === norm(setor)) || null;
    const PR = "PR", SC = "SC";
    const SETORES = {
      "Compras e licitações": [[PR, "LICITAÇÃO PM"], [SC, "LICITAÇÃO PM"], [PR, "LICITAÇÃO CM"], [SC, "LICITAÇÃO CM"], [PR, "Compras PM"], [PR, "Compras CM"],
        [SC, "COMPRAS"], [PR, "PREGOEIRO"], [SC, "PREGOEIRO"], [PR, "LICITAÇÃO PM - com população"], [PR, "Licitação CM com Papulação"],
        [SC, "SAUDE LICITACAO"], [PR, "ETP E TR"]],
      "Transparência e ouvidoria": [[PR, "TRANSPARENCIA PM"], [PR, "Controle interno"], [SC, "CONTROLE INTERNO PM"], [PR, "Controle Interno - CM"], [SC, "CONTROLE INTERNO CM"]],
      "Gestão e fiscalização de contratos": [[PR, "GESTOR E FISCAL DE CONTRATOS"], [SC, "Agente de contrataçãoFiscais"], [PR, "JURIDICO PM"], [SC, "JURIDICO PM"],
        [PR, "JURIDICO CM"], [SC, "JURIDICO CM"]],
      "Patrimônio e frotas": [[PR, "PATRIMONIO PM"], [PR, "FROTAS E PATRIMONIO PM"], [SC, "PATRIMONIOFROTAS PM"], [PR, "Patrimonio CM"], [SC, "PATRIMONIOFROTAS CM"]],
      "Contabilidade e tesouraria": [[PR, "CONTABILIDADE PM"], [SC, "CONTABILIDADE PM"], [PR, "TESOURARIA PM"], [SC, "TESOURARIA PM"], [PR, "FINANÇAS PM"],
        [PR, "CONTABILIDADE CM"], [SC, "CONTABILIDADE CM"], [PR, "TESOURARIA CM"], [SC, "TESOURARIA CM"], [PR, "Planejamento"], [SC, "PLANEJAMENTO"]],
      "Administração e servidores": [[PR, "RH PM"], [SC, "RH PM"], [PR, "RH CM"], [SC, "RH CM"], [PR, "Servidores CM"], [PR, "Servidores Secretários"], [SC, "SERVIDORES"]],
      "Legislativo e assessoria": [[PR, "Legislativo CM"], [SC, "LEGISLATIVO CM"], [PR, "ASSESSOR CM"], [SC, "ASSESSOR CM"], [PR, "Chefe de Gabinete CM"],
        [PR, "COMUNICAÇÃO CM"], [SC, "COMUNICAÇÃO CM"]],
    };
    SETORES["Turmas 2027 (todos os setores)"] = [...new Map(Object.values(SETORES).flat().map((s) => [s.join("|"), s])).values()];
    // [curso, setor, turma (data de início), captação de, até, papel]
    const CURSOS = [
      ["LICITAEXPO Blindagem nas Licitações", "Compras e licitações", "2026-11-24", "2026-11-11", "2026-11-13", "licitaexpo"],
      ["Compras, Licitações e Contratos", "Compras e licitações", "2026-12-01", "2026-11-16", "2026-11-27", "curso"],
      ["Portal, LGPD, e-SIC e Ouvidoria", "Transparência e ouvidoria", "2026-12-01", "2026-11-16", "2026-11-27", "curso"],
      ["Fiscais de Contratos e Papel do Gestor", "Gestão e fiscalização de contratos", "2026-12-08", "2026-11-16", "2026-12-04", "curso"],
      ["Patrimônio Público com IA", "Patrimônio e frotas", "2026-12-08", "2026-11-23", "2026-12-04", "curso"],
      ["Encerramento do Exercício Municipal", "Contabilidade e tesouraria", "2026-12-08", "2026-11-23", "2026-12-04", "curso"],
      ["Formação Técnica para Servidor Público", "Administração e servidores", "2026-12-08", "2026-11-23", "2026-12-04", "curso"],
      ["IA na Câmara Municipal", "Legislativo e assessoria", "2026-12-15", "2026-11-30", "2026-12-11", "curso"],
      ["Licitações com Inteligência Artificial", "Compras e licitações", "2026-12-15", "2026-11-30", "2026-12-11", "curso"],
      ["Turmas 2027", "Turmas 2027 (todos os setores)", null, "2026-12-14", "2026-12-15", "2027"],
    ];
    const agora = new Date().toISOString();
    const nomesUsados = new Set(db.prepare("SELECT nome FROM rota_tipos").all().map((r) => r.nome));
    const novoTipo = (nomeBase, setores, turmas) => {
      let nome = nomeBase;
      if (nomesUsados.has(nome)) nome = `${nomeBase} (fim de ano)`;
      nomesUsados.add(nome);
      return Number(db.prepare("INSERT INTO rota_tipos (nome, setores_json, cota, ativo, turmas_json, criado_em) VALUES (?, ?, 45, 1, ?, ?)")
        .run(nome, JSON.stringify(setores), JSON.stringify(turmas), agora).lastInsertRowid);
    };
    const insCurso = db.prepare("INSERT INTO fim_ano_cursos (tipo_id, curso, setor, turma, captacao_de, captacao_ate, ordem, papel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const faltando = [];
    CURSOS.forEach(([curso, setor, turma, de, ate, papel], i) => {
      const abas = SETORES[setor].map(([uf, s]) => { const r = resolver(uf, s); if (!r && existentes.length) faltando.push(`${uf} "${s}"`); return r; })
        .filter(Boolean).map((x) => ({ uf: x.uf, setor: x.setor }));
      const id = novoTipo(curso, abas, turma ? [{ curso, data: turma }] : []);
      insCurso.run(id, curso, setor, turma, de, ate, i + 1, papel);
    });
    const idNovos = novoTipo("Órgãos novos", [], []);
    insCurso.run(idNovos, "Órgãos novos (consórcios, autarquias, RPPS)", "Órgãos novos", null, "2026-11-11", "2026-12-15", 99, "novos");
    if (faltando.length) console.warn(`⚠ migração 36: abas inexistentes na base (ficam de fora): ${[...new Set(faltando)].join(", ")}`);
    console.log(`migração 36: rota finalização de ano — Danilo cadastrado (#${pid("Danilo")}, sem ramal); ${FAIXAS.length} faixas alfabéticas ` +
      `(11/11–15/12); ${CURSOS.length + 1} tipos de rota novos (cursos, LicitaExpo, Turmas 2027, Órgãos novos). Nada muda nas rotas até publicar o plano em /fim-de-ano.`);
  },
  // 37 — DANILO e TROCA DE RAMAIS COM VIGÊNCIA (decisões do usuário, 2026-11-10).
  // - Danilo de Souza Santana: "Danilo Santana" no wallet da Unyflex e no
  //   Vendedor do Omie (backfill só onde pessoa_id IS NULL).
  // - A partir de 11/11/2026: Frederico sai do 2005 e vai para o 2004 (livre
  //   desde a saída do Jhonnata); Danilo assume o 2005. Por ramal_vigencias,
  //   NUNCA reatribuição total: 2005 até 10/11 = Frederico, de 11/11 = Danilo;
  //   2004 até 21/09 = Douglas, 22/09–02/10 = Jhonnata, 03/10–10/11 SEM dono,
  //   de 11/11 = Frederico. O importador do CDR passou a não cair em
  //   pessoas.ramal quando o ramal tem vigência (senão a lacuna iria ao Frederico).
  () => {
    const VIRADA = "2026-11-11", ANTES = "2026-11-10";
    const id = (n) => db.prepare("SELECT id FROM pessoas WHERE nome = ? AND tipo = 'consultor'").get(n)?.id;
    const fred = id("Frederico"), danilo = id("Danilo");
    if (!fred || !danilo) throw new Error("migração 37: Frederico ou Danilo não encontrado — abortada");
    const NOMES_DANILO = ["Danilo Santana", "Danilo de Souza Santana", "Danilo Souza Santana"];
    db.prepare("UPDATE pessoas SET wallet_nome = 'Danilo Santana', nomes_alternativos = ? WHERE id = ?").run(JSON.stringify(NOMES_DANILO), danilo);
    const nomes = NOMES_DANILO.map((n) => n.toLowerCase());
    const marc = nomes.map(() => "?").join(", ");
    const mat = db.prepare(`UPDATE matriculas SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(wallet)) IN (${marc})`).run(danilo, ...nomes).changes;
    const opo = db.prepare(`UPDATE oportunidades SET pessoa_id = ? WHERE pessoa_id IS NULL AND lower(trim(vendedor)) IN (${marc})`).run(danilo, ...nomes).changes;

    const vig = db.prepare("INSERT INTO ramal_vigencias (ramal, pessoa_id, vigente_desde, vigente_ate) VALUES (?, ?, ?, ?)");
    // 2005: Frederico desde sempre até 10/11 (se o ramal ainda não tem vigência), Danilo de 11/11
    if (!db.prepare("SELECT 1 FROM ramal_vigencias WHERE ramal = '2005'").get()) vig.run("2005", fred, null, ANTES);
    else db.prepare("UPDATE ramal_vigencias SET vigente_ate = ? WHERE ramal = '2005' AND pessoa_id = ? AND (vigente_ate IS NULL OR vigente_ate > ?)").run(ANTES, fred, ANTES);
    vig.run("2005", danilo, VIRADA, null);
    // 2004: Douglas e Jhonnata já têm vigência fechada (migrações 26 e 30); a lacuna fica
    vig.run("2004", fred, VIRADA, null);
    // pessoas.ramal: o dono ATUAL (UNIQUE — solta o 2005 antes)
    db.prepare("UPDATE pessoas SET ramal = NULL WHERE ramal IN ('2004', '2005')").run();
    db.prepare("UPDATE pessoas SET ramal = '2004' WHERE id = ?").run(fred);
    db.prepare("UPDATE pessoas SET ramal = '2005' WHERE id = ?").run(danilo);
    // ligações já importadas: só as de 11/11 em diante mudam de dono
    const p2005 = db.prepare("UPDATE ligacoes SET pessoa_id = ? WHERE ramal = '2005' AND data_hora >= ? AND (pessoa_id IS NULL OR pessoa_id != ?)")
      .run(danilo, `${VIRADA}T00:00:00`, danilo).changes;
    const p2004 = db.prepare("UPDATE ligacoes SET pessoa_id = ? WHERE ramal = '2004' AND data_hora >= ? AND (pessoa_id IS NULL OR pessoa_id != ?)")
      .run(fred, `${VIRADA}T00:00:00`, fred).changes;
    const conta = (ramal, de, ate, pessoa) => db.prepare(
      `SELECT COUNT(*) n FROM ligacoes WHERE ramal = ? AND (? IS NULL OR data_hora >= ?) AND (? IS NULL OR data_hora <= ?) AND pessoa_id IS ?`
    ).get(ramal, de, de && `${de}T00:00:00`, ate, ate && `${ate}T23:59:59`, pessoa).n;
    const nomeDe = (pid) => db.prepare("SELECT nome FROM pessoas WHERE id = ?").get(pid)?.nome;
    const jh = id("Jhonnata"), dg = id("Douglas");
    console.log(`migração 37: Danilo = "Danilo Santana" (wallet/Omie) — backfill ${mat} matrícula(s), ${opo} oportunidade(s).`);
    console.log(`migração 37: ramais a partir de ${VIRADA} — 2005: Frederico até 10/11 = ${conta("2005", null, ANTES, fred)} ligação(ões), ` +
      `Danilo de 11/11 = ${conta("2005", VIRADA, null, danilo)} (${p2005} reatribuída(s) agora); ` +
      `2004: ${dg ? `${nomeDe(dg)} até 21/09 = ${conta("2004", null, "2026-09-21", dg)}, ` : ""}${jh ? `Jhonnata 22/09–02/10 = ${conta("2004", "2026-09-22", "2026-10-02", jh)}, ` : ""}` +
      `sem dono 03/10–10/11 = ${conta("2004", "2026-10-03", ANTES, null)}, Frederico de 11/11 = ${conta("2004", VIRADA, null, fred)} (${p2004} reatribuída(s) agora).`);
  },
  // 38 — COTA INDIVIDUAL DE FIM DE ANO (decisão do usuário, 2026-11-10):
  // R$ 100 mil (supermeta) e R$ 80 mil (base) por vendedor do plano, até
  // 15/12, sobre as matrículas de nov/dez (fimdeano.js). Indicadores
  // `cota_fim_ano_super` e `cota_fim_ano_base` (centavos), editáveis em /metas
  // com a mesma vigência das outras metas; padrão (pessoa_id NULL) desde
  // 01/11/2026. Renato não tem cota (não está nas faixas do plano). O SQLite
  // não altera CHECK: a tabela é recriada e a contagem conferida.
  () => {
    const antes = db.prepare("SELECT COUNT(*) n FROM metas").get().n;
    db.exec(`
      CREATE TABLE metas_nova (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pessoa_id     INTEGER REFERENCES pessoas(id),
        indicador     TEXT    NOT NULL CHECK (indicador IN (
                        'ligacoes_dia', 'leads_dia', 'matriculas_dia', 'receita_dia', 'pipeline_dia',
                        'receita_semana',
                        'ligacoes_mes', 'leads_mes', 'matriculas_mes', 'receita_mes',
                        'receita_semana_equipe', 'receita_mes_equipe',
                        'cota_fim_ano_super', 'cota_fim_ano_base')),
        valor         REAL    NOT NULL,
        vigente_desde TEXT    NOT NULL,
        vigente_ate   TEXT,
        UNIQUE (indicador, pessoa_id, vigente_desde)
      );
      INSERT INTO metas_nova (id, pessoa_id, indicador, valor, vigente_desde, vigente_ate)
        SELECT id, pessoa_id, indicador, valor, vigente_desde, vigente_ate FROM metas;
      DROP TABLE metas;
      ALTER TABLE metas_nova RENAME TO metas;
    `);
    const depois = db.prepare("SELECT COUNT(*) n FROM metas").get().n;
    if (depois !== antes) throw new Error(`migração 38: metas ${antes} → ${depois} — abortada`);
    const ins = db.prepare("INSERT INTO metas (pessoa_id, indicador, valor, vigente_desde) VALUES (NULL, ?, ?, '2026-11-01')");
    ins.run("cota_fim_ano_super", 10000000);
    ins.run("cota_fim_ano_base", 8000000);
    console.log(`migração 38: ${depois} meta(s) preservadas; cota individual de fim de ano = R$ 100.000 (supermeta) e R$ 80.000 (base) por vendedor, desde 01/11.`);
  },
  // 39 — MARKETING, Fase 1 (decisões do usuário, 2026-11-12; marketing.js):
  // papel `marketing` (só código — usuarios.papel não tem CHECK) e o e-mail
  // marketing do Gustavo, gerado das turmas futuras da cópia da Unyflex.
  // - turmas.vista_em: quando o sync viu a turma pela 1ª vez (NULL = antes
  //   desta migração); turmas.fora_da_origem_em: a turma saiu do filtro da
  //   origem (desativada/cancelada) — sai das pendências, fica no histórico.
  // - marketing_envios: 3 por turma (1 divulgação, 2 intermediário, 3 últimas
  //   vagas); `antecedencia_dias` é a regra que valia quando o envio NASCEU
  //   (nunca recalculada); prazo = data da turma − antecedência, derivado na
  //   leitura (turma adiada leva o prazo junto). Nunca apagado.
  // - marketing_eventos: trilha de cada check e de cada check desfeito.
  // - configuracoes: marketing_ativado_em (hoje — prazo anterior = RETROATIVO,
  //   fora do indicador de atraso) e marketing_email_virada (30/15/7 → 60/30/15).
  () => {
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    db.exec(`
      ALTER TABLE turmas ADD COLUMN vista_em TEXT;
      ALTER TABLE turmas ADD COLUMN fora_da_origem_em TEXT;
      CREATE TABLE marketing_envios (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        turma_id          INTEGER NOT NULL REFERENCES turmas(id),
        ordem             INTEGER NOT NULL CHECK (ordem IN (1, 2, 3)),
        antecedencia_dias INTEGER NOT NULL CHECK (antecedencia_dias > 0),
        nasceu_em         TEXT    NOT NULL,
        enviado_em        TEXT,
        enviado_por       INTEGER REFERENCES usuarios(id),
        UNIQUE (turma_id, ordem)
      );
      CREATE TABLE marketing_eventos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        envio_id   INTEGER NOT NULL REFERENCES marketing_envios(id),
        tipo       TEXT    NOT NULL CHECK (tipo IN ('enviado', 'desfeito')),
        usuario_id INTEGER REFERENCES usuarios(id),
        em         TEXT    NOT NULL,
        observacao TEXT
      );
      CREATE INDEX idx_marketing_eventos_envio ON marketing_eventos(envio_id);
    `);
    const cfg = db.prepare("INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO NOTHING");
    cfg.run("marketing_ativado_em", hoje);
    cfg.run("marketing_email_virada", "2027-01-01");
    console.log(`migração 39: marketing — e-mails ativados em ${hoje} (prazo anterior = retroativo); regra 30/15/7 até 31/12/2026, 60/30/15 desde 01/01/2027.`);
  },
  // 40 — MARKETING, Fase 2 (decisões do usuário, 2026-11-12; marketing.js):
  // - marketing_turmas_excluidas: turma que NÃO gera e-mail (assinatura
  //   recorrente como Monitoramento ProLegis/ProGov), ligada caso a caso pelo
  //   ADMIN na tela. Sai das pendências e do indicador; os envios já gerados
  //   ficam no banco (histórico) e voltam se a turma for reincluída.
  // - marketing_ads: campanhas de ADS em 5 slots FIXOS por setor; ativa =
  //   encerrada_em NULL (no máximo uma por setor, índice parcial). Trocar o
  //   curso encerra a anterior com data de fim — o histórico por setor fica.
  // - marketing_whatsapp: check SEMANAL dos grupos (1 por semana, devido no 1º
  //   dia útil da semana). Semana = segunda ISO. Cobrança começa na primeira
  //   semana cujo dia devido é ≥ marketing_whatsapp_desde (hoje).
  // - marketing_log: trilha das ações de ADS, WhatsApp e exclusões.
  () => {
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    db.exec(`
      CREATE TABLE marketing_turmas_excluidas (
        turma_id   INTEGER PRIMARY KEY REFERENCES turmas(id),
        motivo     TEXT,
        usuario_id INTEGER REFERENCES usuarios(id),
        em         TEXT NOT NULL
      );
      CREATE TABLE marketing_ads (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        setor                     TEXT    NOT NULL CHECK (setor IN ('licitacao', 'comunicacao', 'reforma_tributaria', 'financas', 'portal')),
        turma_id                  INTEGER NOT NULL REFERENCES turmas(id),
        inicio                    TEXT    NOT NULL,
        data_curso                TEXT    NOT NULL,
        orcamento_diario_centavos INTEGER NOT NULL CHECK (orcamento_diario_centavos >= 0),
        criada_em                 TEXT    NOT NULL,
        criada_por                INTEGER REFERENCES usuarios(id),
        encerrada_em              TEXT,
        encerrada_por             INTEGER REFERENCES usuarios(id),
        motivo_fim                TEXT
      );
      CREATE UNIQUE INDEX idx_marketing_ads_ativa ON marketing_ads(setor) WHERE encerrada_em IS NULL;
      CREATE TABLE marketing_whatsapp (
        semana     TEXT PRIMARY KEY,
        devido_em  TEXT NOT NULL,
        feito_em   TEXT NOT NULL,
        feito_por  INTEGER REFERENCES usuarios(id),
        observacao TEXT
      );
      CREATE TABLE marketing_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        area       TEXT NOT NULL,
        ref        TEXT,
        acao       TEXT NOT NULL,
        detalhe    TEXT,
        usuario_id INTEGER REFERENCES usuarios(id),
        em         TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('marketing_whatsapp_desde', ?) ON CONFLICT(chave) DO NOTHING").run(hoje);
    console.log(`migração 40: marketing — exclusão de turma do e-mail, ADS (5 slots), check semanal de WhatsApp cobrado a partir de ${hoje}.`);
  },
  // 41 — MARKETING, Fase 2: PLANNER DE CONTEÚDO (decisões do usuário,
  // 2026-11-12; planner.js). Migra o artifact "Funil de Conteúdo Unyflex".
  // - planner_posts: 1 linha por post da planilha (chave = a mesma do artifact:
  //   AAAAMMDD-canal-curso). `data` = data de referência do atraso, que só o
  //   ADMIN muda (replanejar, com motivo, em planner_replanejamentos);
  //   reimportar NUNCA muda a data. `responsavel` = quem PUBLICA, lido do
  //   "Dono" (kesley | gustavo). Estados planejado → produzido → publicado,
  //   com carimbo; publicado exige link; "não vai sair" exige motivo.
  //   `migrado` = estado vindo do artifact sem carimbo (retroativo).
  // - vínculo com turmas: 0, 1 ou várias (planner_post_turmas) ou um tipo
  //   explícito (institucional | setor | livre); `pendente` = o texto não
  //   casou e espera a ligação manual (planner_vinculos_texto guarda a decisão
  //   por texto, reaplicada a cada importação).
  // - planner_extras (feito extra, link obrigatório), planner_rotina (checks
  //   da rotina semanal, por item, com carimbo).
  // - configuracoes: marketing_planner_desde (post com data anterior =
  //   retroativo, fora do indicador) e marketing_meta_conversas (5/semana).
  () => {
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    db.exec(`
      CREATE TABLE planner_posts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        chave             TEXT    NOT NULL UNIQUE,
        data_original     TEXT    NOT NULL,
        data              TEXT    NOT NULL,
        canal             TEXT    NOT NULL,
        etapa             TEXT,
        curso_texto       TEXT,
        gancho            TEXT,
        formato           TEXT,
        peca_mae          TEXT,
        dono_texto        TEXT,
        responsavel       TEXT CHECK (responsavel IN ('kesley', 'gustavo')),
        situacao_planilha TEXT,
        observacao        TEXT,
        vinculo           TEXT    NOT NULL DEFAULT 'pendente' CHECK (vinculo IN ('turmas', 'institucional', 'setor', 'livre', 'pendente')),
        setor             TEXT,
        estado            TEXT    NOT NULL DEFAULT 'planejado' CHECK (estado IN ('planejado', 'produzido', 'publicado', 'nao_vai_sair')),
        produzido_em      TEXT,
        produzido_por     INTEGER REFERENCES usuarios(id),
        publicado_em      TEXT,
        publicado_por     INTEGER REFERENCES usuarios(id),
        link              TEXT,
        alcance           INTEGER,
        engajamento       INTEGER,
        conversas         INTEGER,
        motivo            TEXT,
        proxima           TEXT,
        nao_sai_motivo    TEXT,
        nao_sai_em        TEXT,
        nao_sai_por       INTEGER REFERENCES usuarios(id),
        migrado           INTEGER NOT NULL DEFAULT 0,
        fora_do_plano_em  TEXT,
        fonte             TEXT,
        importacao_id     INTEGER,
        criado_em         TEXT    NOT NULL,
        atualizado_em     TEXT    NOT NULL
      );
      CREATE INDEX idx_planner_posts_data ON planner_posts(data);
      CREATE TABLE planner_post_turmas (
        post_id  INTEGER NOT NULL REFERENCES planner_posts(id),
        turma_id INTEGER NOT NULL REFERENCES turmas(id),
        metodo   TEXT    NOT NULL CHECK (metodo IN ('auto', 'manual')),
        PRIMARY KEY (post_id, turma_id)
      );
      CREATE TABLE planner_vinculos_texto (
        curso_texto TEXT PRIMARY KEY,
        vinculo     TEXT NOT NULL CHECK (vinculo IN ('turmas', 'institucional', 'setor', 'livre')),
        setor       TEXT,
        turmas_json TEXT,
        usuario_id  INTEGER REFERENCES usuarios(id),
        em          TEXT NOT NULL
      );
      CREATE TABLE planner_replanejamentos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id    INTEGER NOT NULL REFERENCES planner_posts(id),
        de         TEXT NOT NULL,
        para       TEXT NOT NULL,
        motivo     TEXT NOT NULL,
        usuario_id INTEGER REFERENCES usuarios(id),
        em         TEXT NOT NULL
      );
      CREATE TABLE planner_extras (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        data        TEXT    NOT NULL,
        formato     TEXT    NOT NULL,
        canal       TEXT    NOT NULL,
        titulo      TEXT    NOT NULL,
        link        TEXT    NOT NULL,
        alcance     INTEGER,
        engajamento INTEGER,
        conversas   INTEGER,
        obs         TEXT,
        criado_em   TEXT    NOT NULL,
        criado_por  INTEGER REFERENCES usuarios(id),
        atualizado_em TEXT  NOT NULL
      );
      CREATE TABLE planner_rotina (
        semana     TEXT NOT NULL,
        item       TEXT NOT NULL,
        feito_em   TEXT NOT NULL,
        feito_por  INTEGER REFERENCES usuarios(id),
        PRIMARY KEY (semana, item)
      );
    `);
    const cfg = db.prepare("INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO NOTHING");
    cfg.run("marketing_planner_desde", hoje);
    cfg.run("marketing_meta_conversas", "5");
    console.log(`migração 41: planner de conteúdo — indicador a partir de ${hoje} (post anterior = retroativo); meta de 5 conversas por semana.`);
  },
  // 42 — WhatsApp do marketing: o ADMIN pode registrar uma semana PASSADA
  // (decisão do usuário, 2026-11-12: ele fez e esqueceu de marcar). `feito_em`
  // passa a ser a data EM QUE FOI FEITO (informada pelo admin; é ela que conta
  // para o atraso) e `registrado_em`/`registrado_por` guardam quem marcou e
  // quando. Check normal: registrado = feito. `informado_admin = 1` marca os
  // registros feitos depois da semana.
  () => {
    db.exec(`
      ALTER TABLE marketing_whatsapp ADD COLUMN registrado_em TEXT;
      ALTER TABLE marketing_whatsapp ADD COLUMN registrado_por INTEGER REFERENCES usuarios(id);
      ALTER TABLE marketing_whatsapp ADD COLUMN informado_admin INTEGER NOT NULL DEFAULT 0;
      UPDATE marketing_whatsapp SET registrado_em = feito_em, registrado_por = feito_por WHERE registrado_em IS NULL;
    `);
    console.log("migração 42: WhatsApp do marketing — admin pode registrar semana passada (data informada + quem marcou e quando).");
  },
  // 43 — PATRIMÔNIO, Fase 1 (2026-11-18): `importacoes` é recriada para aceitar
  // os tipos 'patrimonio' e 'consumo' (este já reservado para a Fase 2, para
  // não repetir a recriação — decisão do usuário). Mesma receita da 20: SQLite
  // não altera CHECK; a tabela é referenciada por ligacoes/oportunidades/
  // matriculas/contatos_ativo…, então roda com foreign_keys OFF (`desligarFk`) e
  // o runner confere foreign_key_check. Ids e o contador AUTOINCREMENT são
  // preservados; aborta se a contagem mudar.
  Object.assign(() => {
    const antes = db.prepare("SELECT COUNT(*) n FROM importacoes").get().n;
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'importacoes'").get()?.seq ?? 0;
    db.exec(`
      CREATE TABLE importacoes_nova (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo                  TEXT    NOT NULL CHECK (tipo IN ('cdr','oportunidades','mysql','prospeccao','patrimonio','consumo')),
        arquivo_nome          TEXT,
        hash_sha256           TEXT,
        linhas_lidas          INTEGER NOT NULL DEFAULT 0,
        linhas_validas        INTEGER NOT NULL DEFAULT 0,
        linhas_ignoradas      INTEGER NOT NULL DEFAULT 0,
        registros_novos       INTEGER NOT NULL DEFAULT 0,
        registros_atualizados INTEGER NOT NULL DEFAULT 0,
        detalhes_json         TEXT    NOT NULL DEFAULT '{}',
        status                TEXT    NOT NULL DEFAULT 'concluida' CHECK (status IN ('concluida','erro')),
        erro                  TEXT,
        usuario_id            INTEGER NOT NULL REFERENCES usuarios(id),
        iniciado_em           TEXT    NOT NULL,
        concluido_em          TEXT,
        registros_identicos   INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO importacoes_nova (id, tipo, arquivo_nome, hash_sha256, linhas_lidas, linhas_validas,
        linhas_ignoradas, registros_novos, registros_atualizados, detalhes_json, status, erro,
        usuario_id, iniciado_em, concluido_em, registros_identicos)
      SELECT id, tipo, arquivo_nome, hash_sha256, linhas_lidas, linhas_validas, linhas_ignoradas,
        registros_novos, registros_atualizados, detalhes_json, status, erro, usuario_id, iniciado_em,
        concluido_em, registros_identicos FROM importacoes;
      DROP TABLE importacoes;
      ALTER TABLE importacoes_nova RENAME TO importacoes;
      CREATE INDEX idx_importacoes_tipo ON importacoes(tipo, iniciado_em);
      CREATE INDEX idx_importacoes_hash ON importacoes(hash_sha256);
    `);
    const depois = db.prepare("SELECT COUNT(*) n FROM importacoes").get().n;
    if (depois !== antes) throw new Error(`migração 43: importacoes tinha ${antes} linha(s) e ficou com ${depois} — abortada`);
    db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'importacoes'").run(seq);
    console.log(`migração 43: importacoes recriada aceitando 'patrimonio' e 'consumo' — antes ${antes}, depois ${depois} registro(s) (iguais); contador AUTOINCREMENT ${seq}.`);
  }, { desligarFk: true }),

  // 44 — PATRIMÔNIO, Fase 1 (2026-11-18, decisões do usuário):
  // - pessoas do tipo NOVO 'administrativo' (Emanuelle, responsável pelo
  //   controle, Emily, Juliana, Marly, Caetano, Pablo), com entra_painel/
  //   entra_tv/entra_feedback = 0. O comercial lista só tipo = 'consultor'
  //   (ranking, meta, prêmio, rota, TV, feedback) e os casamentos por nome
  //   (Omie, wallet, planilha de prospecção) só olham consultor/canal — então
  //   nenhum deles entra no comercial.
  // - locais (andar × sala), seed de 16 na ordem do caminho de colagem.
  // - patrimonio_itens = estado ATUAL; patrimonio_movimentos = histórico,
  //   imutável (gatilhos recusam UPDATE e DELETE). Toda mudança de pessoa,
  //   local ou status grava um movimento.
  // - patrimonio_termos: entrega | devolução, numerados por ano (0001/2026),
  //   assinatura PNG em base64 travada por gatilho; só os campos de
  //   cancelamento mudam, uma vez.
  // - patrimonio_termo_itens.aberto: índice único parcial — o mesmo item em
  //   dois termos abertos é recusado pelo banco.
  // CPF não é guardado (a via sai com a linha em branco).
  () => {
    const novaPessoa = db.prepare(
      `INSERT INTO pessoas (nome, ativo, entra_feedback, tipo, entra_painel, entra_tv, nomes_alternativos)
       SELECT ?, 1, 0, 'administrativo', 0, 0, '[]'
       WHERE NOT EXISTS (SELECT 1 FROM pessoas WHERE nome = ? AND tipo = 'administrativo')`
    );
    const criadas = [];
    for (const nome of ["Emanuelle", "Emily", "Juliana", "Marly", "Caetano", "Pablo"]) {
      if (novaPessoa.run(nome, nome).changes) criadas.push(nome);
    }
    db.exec(`
      CREATE TABLE locais (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        andar  INTEGER NOT NULL,
        nome   TEXT    NOT NULL,
        ordem  INTEGER NOT NULL DEFAULT 0,
        ativo  INTEGER NOT NULL DEFAULT 1,
        UNIQUE (andar, nome)
      );
      CREATE TABLE patrimonio_itens (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo             TEXT    NOT NULL UNIQUE CHECK (length(codigo) = 4 AND codigo GLOB '[0-9][0-9][0-9][0-9]'),
        nome               TEXT    NOT NULL,
        marca_modelo       TEXT,
        numero_serie       TEXT,
        categoria          TEXT,
        estado_conservacao TEXT    CHECK (estado_conservacao IN ('bom','regular','ruim')),
        status             TEXT    NOT NULL DEFAULT 'em_estoque' CHECK (status IN ('em_uso','em_estoque','em_reparo','baixado')),
        local_id           INTEGER REFERENCES locais(id),
        pessoa_id          INTEGER REFERENCES pessoas(id),
        conjunto           TEXT,
        valor_centavos     INTEGER,
        data_aquisicao     TEXT,
        nota_fiscal        TEXT,
        observacao         TEXT,
        codigo_antigo      TEXT,
        origem             TEXT,
        extras_json        TEXT,
        importacao_id      INTEGER REFERENCES importacoes(id),
        criado_em          TEXT    NOT NULL,
        atualizado_em      TEXT,
        baixado_em         TEXT,
        motivo_baixa       TEXT
      );
      CREATE INDEX idx_patrimonio_itens_pessoa ON patrimonio_itens(pessoa_id);
      CREATE INDEX idx_patrimonio_itens_local ON patrimonio_itens(local_id);

      CREATE TABLE patrimonio_termos (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo                 TEXT    NOT NULL CHECK (tipo IN ('entrega','devolucao')),
        ano                  INTEGER NOT NULL,
        seq                  INTEGER NOT NULL,
        pessoa_id            INTEGER NOT NULL REFERENCES pessoas(id),
        local_id             INTEGER REFERENCES locais(id),
        data_hora            TEXT    NOT NULL,
        assinatura           TEXT    NOT NULL CHECK (assinatura LIKE 'data:image/png;base64,%'),
        assinante_nome       TEXT    NOT NULL,
        usuario_id           INTEGER NOT NULL REFERENCES usuarios(id),
        observacao           TEXT,
        relacionado_id       INTEGER REFERENCES patrimonio_termos(id), -- transferência: devolução ↔ entrega
        cancelado_em         TEXT,
        motivo_cancelamento  TEXT,
        cancelado_por        INTEGER REFERENCES usuarios(id),
        UNIQUE (ano, seq)
      );
      CREATE INDEX idx_patrimonio_termos_pessoa ON patrimonio_termos(pessoa_id);

      CREATE TABLE patrimonio_termo_itens (
        termo_id          INTEGER NOT NULL REFERENCES patrimonio_termos(id),
        item_id           INTEGER NOT NULL REFERENCES patrimonio_itens(id),
        aberto            INTEGER NOT NULL DEFAULT 0 CHECK (aberto IN (0, 1)),
        fechado_por_termo INTEGER REFERENCES patrimonio_termos(id), -- devolução que fechou esta entrega
        fechado_em        TEXT,
        PRIMARY KEY (termo_id, item_id)
      );
      CREATE UNIQUE INDEX idx_patrimonio_um_termo_aberto ON patrimonio_termo_itens(item_id) WHERE aberto = 1;
      CREATE INDEX idx_patrimonio_termo_itens_item ON patrimonio_termo_itens(item_id);

      CREATE TABLE patrimonio_movimentos (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id       INTEGER NOT NULL REFERENCES patrimonio_itens(id),
        tipo          TEXT    NOT NULL CHECK (tipo IN ('entrega','devolucao','transferencia','reparo_saida','reparo_retorno','baixa','ajuste')),
        pessoa_de     INTEGER REFERENCES pessoas(id),
        pessoa_para   INTEGER REFERENCES pessoas(id),
        local_de      INTEGER REFERENCES locais(id),
        local_para    INTEGER REFERENCES locais(id),
        status_de     TEXT,
        status_para   TEXT,
        termo_id      INTEGER REFERENCES patrimonio_termos(id),
        importacao_id INTEGER REFERENCES importacoes(id),
        usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
        data_hora     TEXT    NOT NULL,
        observacao    TEXT
      );
      CREATE INDEX idx_patrimonio_mov_item ON patrimonio_movimentos(item_id, id);

      -- Histórico imutável: movimento nunca é editado nem apagado
      CREATE TRIGGER patrimonio_mov_sem_update BEFORE UPDATE ON patrimonio_movimentos
      BEGIN SELECT RAISE(ABORT, 'patrimonio_movimentos é imutável: movimento não pode ser editado'); END;
      CREATE TRIGGER patrimonio_mov_sem_delete BEFORE DELETE ON patrimonio_movimentos
      BEGIN SELECT RAISE(ABORT, 'patrimonio_movimentos é imutável: movimento não pode ser apagado'); END;

      -- Termo: só o cancelamento muda, uma vez; assinatura e conteúdo travados
      CREATE TRIGGER patrimonio_termo_travado BEFORE UPDATE ON patrimonio_termos
      WHEN NEW.tipo IS NOT OLD.tipo OR NEW.ano IS NOT OLD.ano OR NEW.seq IS NOT OLD.seq
        OR NEW.pessoa_id IS NOT OLD.pessoa_id OR NEW.local_id IS NOT OLD.local_id
        OR NEW.data_hora IS NOT OLD.data_hora OR NEW.assinatura IS NOT OLD.assinatura
        OR NEW.assinante_nome IS NOT OLD.assinante_nome OR NEW.usuario_id IS NOT OLD.usuario_id
        OR NEW.observacao IS NOT OLD.observacao OR NEW.relacionado_id IS NOT OLD.relacionado_id
        OR OLD.cancelado_em IS NOT NULL
        OR NEW.cancelado_em IS NULL OR NEW.motivo_cancelamento IS NULL OR trim(NEW.motivo_cancelamento) = ''
      BEGIN SELECT RAISE(ABORT, 'termo assinado não pode ser alterado (só cancelado, uma vez, com motivo)'); END;
      CREATE TRIGGER patrimonio_termo_sem_delete BEFORE DELETE ON patrimonio_termos
      BEGIN SELECT RAISE(ABORT, 'termo assinado não pode ser apagado'); END;

      -- Itens do termo: só o fechamento/reabertura muda; nunca apagados
      CREATE TRIGGER patrimonio_termo_itens_travado BEFORE UPDATE ON patrimonio_termo_itens
      WHEN NEW.termo_id IS NOT OLD.termo_id OR NEW.item_id IS NOT OLD.item_id
      BEGIN SELECT RAISE(ABORT, 'item do termo não pode trocar de termo nem de item'); END;
      CREATE TRIGGER patrimonio_termo_itens_sem_delete BEFORE DELETE ON patrimonio_termo_itens
      BEGIN SELECT RAISE(ABORT, 'item de termo não pode ser apagado'); END;
    `);
    const local = db.prepare("INSERT INTO locais (andar, nome, ordem) VALUES (?, ?, ?)");
    const LOCAIS = [
      [4, "Sala de reunião"], [4, "Sala auditório"], [4, "Unymotors"], [4, "Clínica de estética"],
      [5, "Sala 04"], [5, "Coordenação 01"], [5, "Coordenação 02"], [5, "Open office"], [5, "Recepção"],
      [6, "Sala 01"], [6, "Sala 02"], [6, "Sala 03"], [6, "Espaço coffee break"], [6, "Recepção"],
      [7, "Cozinha"], [7, "Estoque"],
    ];
    LOCAIS.forEach(([andar, nome], i) => local.run(andar, nome, i + 1));
    console.log(`migração 44: patrimônio — ${LOCAIS.length} locais, tabelas de itens/movimentos/termos; pessoas administrativas criadas: ${criadas.join(", ") || "nenhuma (já existiam)"}.`);
  },
  // 45 — PATRIMÔNIO: a conservação de cada item fica gravada NO TERMO, como
  // estava no ato da assinatura (o texto do termo, aprovado pelo usuário em
  // 18/11/2026, declara "nas condições de conservação indicadas ao lado de cada
  // item"). Editar a conservação do item depois nunca muda um termo assinado:
  // o gatilho passa a travar também esta coluna.
  () => {
    db.exec(`
      ALTER TABLE patrimonio_termo_itens ADD COLUMN conservacao TEXT CHECK (conservacao IN ('bom','regular','ruim'));
      DROP TRIGGER patrimonio_termo_itens_travado;
      CREATE TRIGGER patrimonio_termo_itens_travado BEFORE UPDATE ON patrimonio_termo_itens
      WHEN NEW.termo_id IS NOT OLD.termo_id OR NEW.item_id IS NOT OLD.item_id OR NEW.conservacao IS NOT OLD.conservacao
      BEGIN SELECT RAISE(ABORT, 'item do termo não pode trocar de termo, de item nem de conservação'); END;
    `);
    const n = db.prepare("SELECT COUNT(*) n FROM patrimonio_termo_itens").get().n;
    console.log(`migração 45: patrimônio — conservação gravada no termo (no ato da assinatura); ${n} linha(s) de termo já existente(s) ficam sem conservação registrada.`);
  },

  // 46 — Danilo saiu da equipe; último dia 2026-11-12 (informado em 19/11;
  // decisões do usuário de 19/11 e 23/11/2026, sobre o diagnóstico de produção
  // de scripts/diagnostico-saida-vendedor.js: 0 ligação no 2005 depois de
  // 12/11, 0 baixa nas 22 rotas dele, sem matrícula, oportunidade, carteira
  // nem usuário). Mesmo precedente do Jhonnata (migração 30): NADA do
  // histórico é apagado e ele continua `ativo = 1`.
  // - Flags de painel/TV/feedback em 0 (e OCULTOS_TEMPORARIOS_TV); fora de
  //   CONSULTORES_ATUAIS e VENDEDORES_ORGAOS_NOVOS (prospeccao.js).
  // - Ramal 2005: vigência dele fecha em 12/11; pessoas.ramal NULL; ligação do
  //   2005 de 13/11 em diante perde o dono (o diagnóstico mediu 0).
  // - Faixa dele (PR SALTO DO LONTRA → XAMBRE, SC Santo Amaro da Imperatriz →
  //   Zortéa) fecha em 12/11 e é dividida em QUATRO blocos alfabéticos
  //   contíguos por UF (opção A; limites do diagnóstico de produção,
  //   equilibrados por itens possíveis), um para cada vendedor, valendo de
  //   REFAZ a 15/12. As faixas antigas dos quatro não mudam — cada um passa a
  //   ter duas faixas por UF (municipiosPorPessoa junta as vigentes na data).
  //   Blocos conferidos contra o IBGE: contíguos e cobrindo exatamente a faixa
  //   dele, senão a migração aborta sem mudar nada.
  // - Órgãos novos dele: divididos entre os quatro em rodízio sobre UF → tipo
  //   → município → entidade (o rodízio da importação), histórico pessoa_id
  //   por contato, sem editado_em. Outros contatos com ele como consultor:
  //   ficam sem consultor (como na 30).
  // - Plano: células dele depois de 12/11 apagadas; campanha própria encerrada
  //   em 13/11; rotas dele depois de 12/11 sem baixa descartadas.
  // - Cotas: nada a gravar — sem faixa vigente ele sai da lista de cotas e a
  //   cota dele vira lacuna coletiva sem dono (fimdeano.cotas, 19/11).
  // - Rotas dos quatro de REFAZ a 15/12 sem baixa descartadas; o boot
  //   (garantirRotas) gera de novo o período inteiro, em ordem, já com os
  //   blocos novos e os telefones das rotas dele liberados. REFAZ = 24/11 ou,
  //   se a migração rodar no próprio dia 24 ou depois, amanhã — a rota do dia
  //   nunca é refeita (alguém pode ter começado).
  () => {
    const SAIDA = "2026-11-12", APOS = "2026-11-13", FIM_PLANO = "2026-12-15";
    const somar = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const amanha = somar(hoje, 1);
    const REFAZ = amanha > "2026-11-24" ? amanha : "2026-11-24";
    const QUATRO = ["Frederico", "Agnes", "Eduardo", "Bianca"];
    const BLOCOS = [
      ["Frederico", "PR", "Salto do Lontra", "Santo Antônio do Paraíso", 19],
      ["Agnes", "PR", "Santo Antônio do Sudoeste", "São Pedro do Paraná", 20],
      ["Eduardo", "PR", "São Sebastião da Amoreira", "Tibagi", 21],
      ["Bianca", "PR", "Tijucas do Sul", "Xambrê", 20],
      ["Frederico", "SC", "Santo Amaro da Imperatriz", "São José do Cedro", 15],
      ["Agnes", "SC", "São José do Cerrito", "Taió", 15],
      ["Eduardo", "SC", "Tangará", "Turvo", 14],
      ["Bianca", "SC", "União do Oeste", "Zortéa", 15],
    ];
    const pid = (n) => db.prepare("SELECT id FROM pessoas WHERE nome = ? AND tipo = 'consultor'").get(n)?.id;
    const dan = pid("Danilo");
    if (!dan) throw new Error("migração 46: consultor Danilo não encontrado — abortada");
    const ids = Object.fromEntries(QUATRO.map((n) => [n, pid(n)]));
    const faltam = QUATRO.filter((n) => !ids[n]);
    if (faltam.length) throw new Error(`migração 46: consultor(es) ${faltam.join(", ")} não encontrado(s) — abortada`);
    const admin = db.prepare("SELECT MIN(id) id FROM usuarios WHERE papel = 'admin'").get()?.id;
    if (!admin) throw new Error("migração 46: nenhum admin para registrar o histórico — abortada");
    const agora = new Date().toISOString();
    console.log(`migração 46: saída do Danilo (último dia ${SAIDA}) — hoje ${hoje} (Brasília), refazer rotas de ${REFAZ} a ${FIM_PLANO}.`);

    // ---- faixa: conferir os blocos contra o IBGE ANTES de gravar qualquer coisa
    const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ").trim().replace(/(^| )D (?=[AEIOU])/g, "$1DO ");
    const faixasDele = db.prepare(
      `SELECT id, uf, inicio, fim FROM faixas_vendedor WHERE pessoa_id = ? AND vigente_desde <= ? AND (vigente_ate IS NULL OR vigente_ate >= ?) ORDER BY uf`
    ).all(dan, SAIDA, SAIDA);
    if (faixasDele.length !== 2) throw new Error(`migração 46: esperava 2 faixas do Danilo vigentes em ${SAIDA}, achei ${faixasDele.length} — abortada`);
    for (const f of faixasDele) {
      const ms = db.prepare("SELECT nome FROM municipios WHERE uf = ?").all(f.uf).map((m) => norm(m.nome)).sort();
      const pos = (nome, rot) => {
        const i = ms.indexOf(norm(nome));
        if (i < 0) throw new Error(`migração 46: ${rot} "${nome}" (${f.uf}) não existe no IBGE — abortada`);
        return i;
      };
      const ini = pos(f.inicio, "início da faixa"), fim = pos(f.fim, "fim da faixa");
      const blocos = BLOCOS.filter((b) => b[1] === f.uf);
      let esperado = ini;
      for (const [nome, , a, b, n] of blocos) {
        const i = pos(a, `bloco de ${nome}`), j = pos(b, `bloco de ${nome}`);
        if (i !== esperado) throw new Error(`migração 46: bloco de ${nome} ${f.uf} começa em "${a}", mas o município seguinte ao bloco anterior é "${ms[esperado]}" — abortada`);
        if (j - i + 1 !== n) throw new Error(`migração 46: bloco de ${nome} ${f.uf} tem ${j - i + 1} municípios no IBGE, o diagnóstico disse ${n} — abortada`);
        esperado = j + 1;
      }
      if (esperado !== fim + 1) throw new Error(`migração 46: os blocos de ${f.uf} terminam em "${ms[esperado - 1]}", a faixa do Danilo termina em "${f.fim}" — abortada`);
      console.log(`migração 46: faixa ${f.uf} ${f.inicio} → ${f.fim} (${fim - ini + 1} municípios) = ${blocos.map((b) => `${b[0]} ${b[4]}`).join(" + ")} ✓`);
    }

    // ---- pessoa e ramal
    db.prepare("UPDATE pessoas SET entra_painel = 0, entra_tv = 0, entra_feedback = 0, ramal = NULL WHERE id = ?").run(dan);
    const vig = db.prepare(
      "UPDATE ramal_vigencias SET vigente_ate = ? WHERE ramal = '2005' AND pessoa_id = ? AND (vigente_ate IS NULL OR vigente_ate > ?)"
    ).run(SAIDA, dan, SAIDA).changes;
    const semDono = db.prepare("UPDATE ligacoes SET pessoa_id = NULL WHERE ramal = '2005' AND pessoa_id = ? AND data_hora >= ?")
      .run(dan, `${APOS}T00:00:00`).changes;
    const ficam = db.prepare("SELECT COUNT(*) n FROM ligacoes WHERE pessoa_id = ?").get(dan).n;
    console.log(`migração 46: ramal 2005 — vigência do Danilo fechada em 12/11 (${vig}); ${semDono} ligação(ões) de 13/11 em diante ficaram sem dono; ${ficam} ligação(ões) seguem dele. Painel, TV e feedback desligados (continua ativo).`);
    const usuarios = db.prepare("SELECT id, ativo FROM usuarios WHERE pessoa_id = ?").all(dan);
    if (usuarios.length) {
      const n = db.prepare("UPDATE usuarios SET ativo = 0 WHERE pessoa_id = ? AND ativo = 1").run(dan).changes;
      console.log(`migração 46: ${n} usuário(s) do Danilo desativado(s).`);
    } else {
      console.log("migração 46: Danilo não tem usuário (entrou em 11/11 e nunca teve login) — nada a desativar.");
    }

    // ---- faixas: fecha a dele, abre os blocos
    db.prepare("UPDATE faixas_vendedor SET vigente_ate = ? WHERE pessoa_id = ? AND (vigente_ate IS NULL OR vigente_ate > ?)").run(SAIDA, dan, SAIDA);
    const insFaixa = db.prepare("INSERT INTO faixas_vendedor (pessoa_id, uf, inicio, fim, vigente_desde, vigente_ate) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [nome, uf, a, b] of BLOCOS) insFaixa.run(ids[nome], uf, a, b, REFAZ, FIM_PLANO);
    console.log(`migração 46: faixa do Danilo fechada em 12/11; ${BLOCOS.length} bloco(s) novos de ${REFAZ} a 15/12 — ${BLOCOS.map((b) => `${b[0]} ${b[1]} ${b[2]} → ${b[3]}`).join("; ")}.`);

    // ---- contatos: órgãos novos divididos entre os quatro; o resto liberado
    const hist = db.prepare(
      `INSERT INTO contatos_ativo_historico (contato_id, tipo, canal, campo, valor_anterior, valor_novo, observacao, usuario_id, registrado_em)
       VALUES (?, 'edicao', NULL, 'pessoa_id', ?, ?, ?, ?, ?)`);
    const mudar = db.prepare("UPDATE contatos_ativo SET pessoa_id = ?, atualizado_em = ? WHERE id = ?");
    const orgaos = db.prepare(
      `SELECT id FROM contatos_ativo WHERE pessoa_id = ? AND origem = 'orgaos_novos'
       ORDER BY uf, COALESCE(json_extract(extras_json, '$.Tipo'), ''), COALESCE(municipio_texto, ''), COALESCE(entidade, ''), id`).all(dan);
    const porVendedor = Object.fromEntries(QUATRO.map((n) => [n, 0]));
    orgaos.forEach(({ id }, i) => {
      const nome = QUATRO[i % QUATRO.length];
      mudar.run(ids[nome], agora, id);
      hist.run(id, String(dan), String(ids[nome]), `órgão novo redistribuído: Danilo saiu da equipe (último dia 12/11/2026, migração 46) — para ${nome}`, admin, agora);
      porVendedor[nome]++;
    });
    const outros = db.prepare("SELECT id FROM contatos_ativo WHERE pessoa_id = ?").all(dan);
    for (const { id } of outros) {
      mudar.run(null, agora, id);
      hist.run(id, String(dan), null, "liberado: Danilo saiu da equipe (último dia 12/11/2026, migração 46)", admin, agora);
    }
    console.log(`migração 46: ${orgaos.length} órgão(s) novo(s) do Danilo redistribuído(s) — ${QUATRO.map((n) => `${n} ${porVendedor[n]}`).join(", ")}; ` +
      `${outros.length} outro(s) contato(s) liberado(s) (sem consultor).`);

    // ---- plano, rotas e campanha dele
    const celulas = db.prepare("DELETE FROM fim_ano_plano WHERE pessoa_id = ? AND data > ?").run(dan, SAIDA).changes;
    const comBaixa = db.prepare(
      `SELECT r.data FROM rotas r WHERE r.pessoa_id = ? AND r.data > ? AND EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = r.id AND i.baixa_metodo IS NOT NULL)`
    ).all(dan, SAIDA);
    const rotasDele = db.prepare(
      `DELETE FROM rotas WHERE pessoa_id = ? AND data > ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(dan, SAIDA).changes;
    db.prepare(
      `DELETE FROM rota_campanhas WHERE pessoa_id = ? AND vale_desde >= ? AND NOT EXISTS (SELECT 1 FROM rotas r WHERE r.campanha_id = rota_campanhas.id)`
    ).run(dan, APOS);
    db.prepare("INSERT INTO rota_campanhas (tipo_id, fila_json, vale_desde, criada_em, usuario_id, pessoa_id, modo) VALUES (NULL, '[]', ?, ?, ?, ?, 'prioridade')")
      .run(APOS, agora, admin, dan);
    console.log(`migração 46: ${celulas} célula(s) do plano do Danilo depois de 12/11 apagada(s); ${rotasDele} rota(s) dele sem baixa descartada(s)` +
      (comBaixa.length ? `; ⚠ mantidas por terem baixa: ${comBaixa.map((r) => r.data).join(", ")}` : "") + "; campanha própria encerrada em 13/11.");

    // ---- rotas dos quatro: refazer de REFAZ a 15/12 (o boot gera de novo)
    const marc = QUATRO.map(() => "?").join(",");
    const valores = QUATRO.map((n) => ids[n]);
    const mantidas = db.prepare(
      `SELECT p.nome, r.data FROM rotas r JOIN pessoas p ON p.id = r.pessoa_id WHERE r.data BETWEEN ? AND ? AND r.pessoa_id IN (${marc})
         AND EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = r.id AND i.baixa_metodo IS NOT NULL) ORDER BY r.data`).all(REFAZ, FIM_PLANO, ...valores);
    const refeitas = db.prepare(
      `DELETE FROM rotas WHERE data BETWEEN ? AND ? AND pessoa_id IN (${marc})
         AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`).run(REFAZ, FIM_PLANO, ...valores).changes;
    console.log(`migração 46: ${refeitas} rota(s) dos quatro de ${REFAZ} a 15/12 sem baixa descartada(s) — o boot gera de novo com os blocos novos` +
      (mantidas.length ? `; ⚠ mantidas por terem baixa: ${mantidas.map((m) => `${m.nome} ${m.data}`).join(", ")}` : "") + ".");
  },

  // 47 — PATRIMÔNIO: status 'uso_comum' (2026-11-28, decisão do usuário).
  // Item da sala, de todos (geladeira, fogão, ar-condicionado, TV, projetor):
  // completo com local + conservação, sem responsável nem termo. O SQLite não
  // altera CHECK: patrimonio_itens é recriada com as MESMAS colunas e copiada
  // inteira (ids preservados — movimentos e termos apontam para eles), com
  // foreign_keys OFF (`desligarFk`: termo_itens e movimentos a referenciam). A
  // migração aborta, sem mudar nada, se o total, a contagem por status ou o
  // contador AUTOINCREMENT diferirem. Nenhum item muda de status aqui: os da
  // planilha seguem como estão e são corrigidos pela tela.
  Object.assign(() => {
    const cont = () => db.prepare("SELECT status, COUNT(*) n FROM patrimonio_itens GROUP BY status ORDER BY status").all();
    const antes = cont();
    const total = db.prepare("SELECT COUNT(*) n FROM patrimonio_itens").get().n;
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'patrimonio_itens'").get()?.seq ?? 0;
    const cols = db.prepare("PRAGMA table_info(patrimonio_itens)").all().map((c) => c.name);
    const ESPERADAS = ["id", "codigo", "nome", "marca_modelo", "numero_serie", "categoria", "estado_conservacao", "status", "local_id",
      "pessoa_id", "conjunto", "valor_centavos", "data_aquisicao", "nota_fiscal", "observacao", "codigo_antigo", "origem",
      "extras_json", "importacao_id", "criado_em", "atualizado_em", "baixado_em", "motivo_baixa"];
    if (cols.join() !== ESPERADAS.join()) throw new Error(`migração 47: colunas de patrimonio_itens inesperadas (${cols.join(", ")}) — abortada`);
    db.exec(`
      CREATE TABLE patrimonio_itens_nova (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo             TEXT    NOT NULL UNIQUE CHECK (length(codigo) = 4 AND codigo GLOB '[0-9][0-9][0-9][0-9]'),
        nome               TEXT    NOT NULL,
        marca_modelo       TEXT,
        numero_serie       TEXT,
        categoria          TEXT,
        estado_conservacao TEXT    CHECK (estado_conservacao IN ('bom','regular','ruim')),
        status             TEXT    NOT NULL DEFAULT 'em_estoque' CHECK (status IN ('em_uso','em_estoque','em_reparo','baixado','uso_comum')),
        local_id           INTEGER REFERENCES locais(id),
        pessoa_id          INTEGER REFERENCES pessoas(id),
        conjunto           TEXT,
        valor_centavos     INTEGER,
        data_aquisicao     TEXT,
        nota_fiscal        TEXT,
        observacao         TEXT,
        codigo_antigo      TEXT,
        origem             TEXT,
        extras_json        TEXT,
        importacao_id      INTEGER REFERENCES importacoes(id),
        criado_em          TEXT    NOT NULL,
        atualizado_em      TEXT,
        baixado_em         TEXT,
        motivo_baixa       TEXT,
        CHECK (status <> 'uso_comum' OR pessoa_id IS NULL)
      );
      INSERT INTO patrimonio_itens_nova (${ESPERADAS.join(", ")}) SELECT ${ESPERADAS.join(", ")} FROM patrimonio_itens;
      DROP TABLE patrimonio_itens;
      ALTER TABLE patrimonio_itens_nova RENAME TO patrimonio_itens;
      CREATE INDEX idx_patrimonio_itens_pessoa ON patrimonio_itens(pessoa_id);
      CREATE INDEX idx_patrimonio_itens_local ON patrimonio_itens(local_id);
    `);
    db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'patrimonio_itens'").run(seq);
    const depois = cont();
    const totalDepois = db.prepare("SELECT COUNT(*) n FROM patrimonio_itens").get().n;
    const seqDepois = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'patrimonio_itens'").get()?.seq ?? 0;
    if (totalDepois !== total || JSON.stringify(depois) !== JSON.stringify(antes) || (total && seqDepois !== seq)) {
      throw new Error(`migração 47: patrimonio_itens não bateu (antes ${total} ${JSON.stringify(antes)} seq ${seq}; depois ${totalDepois} ${JSON.stringify(depois)} seq ${seqDepois}) — abortada`);
    }
    console.log(`migração 47: patrimônio — status 'uso_comum' aceito; patrimonio_itens recriada, ${total} item(ns) preservado(s) (${antes.map((x) => `${x.status} ${x.n}`).join(", ") || "vazia"}), contador AUTOINCREMENT ${seq}.`);
  }, { desligarFk: true }),
];

// Migração marcada com `desligarFk` recria uma tabela referenciada por outras:
// foreign_keys só pode ser desligado FORA de transação, e ao fim conferimos
// que nenhuma referência ficou órfã (foreign_key_check) antes de religar.
let versao = db.pragma("user_version", { simple: true });
for (; versao < MIGRACOES.length; versao++) {
  const migracao = MIGRACOES[versao];
  if (migracao.desligarFk) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      migracao();
      if (migracao.desligarFk) {
        const orfas = db.pragma("foreign_key_check");
        if (orfas.length) throw new Error(`migração ${versao + 1}: ${orfas.length} referência(s) órfã(s) após recriar tabela — abortada`);
      }
      db.pragma(`user_version = ${versao + 1}`);
    })();
  } finally {
    if (migracao.desligarFk) db.pragma("foreign_keys = ON");
  }
}

// ---------- Ocultação padrão da TV (TEMPORÁRIO) ----------
// Nomes desta lista ficam com entra_painel = 0 e entra_tv = 0 — fora de TODAS
// as visões da TV — aplicado em TODO startup, DEPOIS das migrações. Assim a
// ocultação sobrevive a banco recriado do zero (o seed roda antes disto) e a
// qualquer UPDATE manual em sentido contrário. Só afeta a TV; /relatorios,
// /saude e feedback continuam com todos.
//
// Para devolver alguém à TV: REMOVER o nome daqui e reiniciar o servidor — a
// restauração para 1/1 é automática e atinge apenas quem foi ocultado por esta
// lista (a chave tv_ocultos_aplicados em `configuracoes` guarda quem foi).
// Renato não passa por aqui (voltou ao painel na migração 14) e não é tocado.
//
// Decisão de 2026-08-19: Hirlan e Douglas fora da TV temporariamente.
// Jhonnata saiu da equipe em 2026-10-02 (migração 30); Danilo em 2026-11-12 (migração 46).
const OCULTOS_TEMPORARIOS_TV = ["Hirlan", "Douglas", "Jhonnata", "Danilo"];

{
  const CHAVE = "tv_ocultos_aplicados";
  const aplicadosAntes = JSON.parse(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(CHAVE)?.valor ?? "[]"
  );
  const restaurar = aplicadosAntes.filter((n) => !OCULTOS_TEMPORARIOS_TV.includes(n));
  const mudarFlags = db.prepare(
    "UPDATE pessoas SET entra_painel = ?, entra_tv = ? WHERE nome = ?"
  );
  db.transaction(() => {
    for (const nome of restaurar) mudarFlags.run(1, 1, nome);
    for (const nome of OCULTOS_TEMPORARIOS_TV) {
      const info = mudarFlags.run(0, 0, nome);
      if (!info.changes) {
        console.warn(`⚠  OCULTOS_TEMPORARIOS_TV: "${nome}" não existe em pessoas — nada ocultado.`);
      }
    }
    db.prepare(
      `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`
    ).run(CHAVE, JSON.stringify(OCULTOS_TEMPORARIOS_TV));
  })();
}


// ---------- Identificação no boot ----------
// Caminho absoluto, versão do esquema e contagem de contatos: a primeira coisa
// a conferir depois de um deploy (se a contagem cair, o banco é outro).
{
  const contatos = db.prepare("SELECT COUNT(*) AS n FROM contatos_ativo").get().n;
  const origem = process.env.DB_PATH ? "DB_PATH" : "padrão local";
  console.log(
    `🗄  Banco: ${CAMINHO_BANCO} (${origem}) · user_version ${db.pragma("user_version", { simple: true })} · ${contatos} contato(s) de prospecção`
  );
}

module.exports = db;
