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
const OCULTOS_TEMPORARIOS_TV = ["Hirlan", "Douglas"];

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
