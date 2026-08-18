"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "aula-ai.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------- Migrações ----------
// Versionamento via PRAGMA user_version: cada função abaixo leva o banco da
// versão N-1 para a versão N, dentro de uma transação (se falhar, a versão não
// avança). Bancos novos e antigos passam pelo mesmo caminho — a migração 1 é o
// baseline idempotente (CREATE IF NOT EXISTS) que ambos já satisfazem.

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
];

let versao = db.pragma("user_version", { simple: true });
for (; versao < MIGRACOES.length; versao++) {
  db.transaction(() => {
    MIGRACOES[versao]();
    db.pragma(`user_version = ${versao + 1}`);
  })();
}

module.exports = db;
