"use strict";

// Ingestão de arquivos da central de dados (CDR do PABX em CSV e oportunidades
// do Omie em .xlsx). Toda importação é idempotente (upsert pela chave natural),
// nunca aborta por linha ruim (linhas problemáticas viram relatório) e registra
// auditoria completa na tabela importacoes.

const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const db = require("./db.js");

const AMOSTRAS_MAX = 20;

// ---------- Utilitários de texto/CSV ----------

function removerBom(texto) {
  const t = String(texto || "");
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t; // BOM do utf-8-sig
}

function hashSha256(dado) {
  return crypto.createHash("sha256").update(dado).digest("hex"); // string utf-8 ou Buffer
}

// Normaliza nomes de cabeçalho: sem acento, sem "º", minúsculas, espaços únicos
function normalizarNome(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/º/g, "o")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function detectarDelimitador(texto) {
  const fimLinha = texto.indexOf("\n");
  const primeiraLinha = fimLinha === -1 ? texto : texto.slice(0, fimLinha);
  const pontoVirgula = (primeiraLinha.match(/;/g) || []).length;
  const virgula = (primeiraLinha.match(/,/g) || []).length;
  return pontoVirgula >= virgula ? ";" : ",";
}

// Lê o CSV com cabeçalhos normalizados; tolera contagem de colunas irregular
// (linha de rodapé do CDR) e aspas dentro de campo.
function lerCsv(texto) {
  return parse(texto, {
    delimiter: detectarDelimitador(texto),
    columns: (cabecalho) => cabecalho.map(normalizarNome),
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

// Duração "HH:MM:SS" → segundos, tolerante a prefixos ("DURAÇÃO: 00:01:05")
const RE_DURACAO = /(\d{1,2}):(\d{2}):(\d{2})/;
function duracaoParaSegundos(texto) {
  const m = RE_DURACAO.exec(String(texto ?? ""));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// "DD/MM/YYYY HH:MM[:SS]" ou "YYYY-MM-DD HH:MM[:SS]" → ISO local (sem Z)
function dataHoraLocalIso(texto) {
  const t = String(texto ?? "").trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] || "00"}`;
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] || "00"}`;
  return null;
}

// "R$ 1.234,56" | "1.234,56" | "1234.56" | "1234" → centavos (INTEGER)
function dinheiroParaCentavos(texto) {
  const t = String(texto ?? "").replace(/[^\d.,-]/g, "");
  if (!t) return null;
  const m = /^-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$|^-?\d+(?:[.,]\d{1,2})?$/.exec(t);
  if (!m) return null;
  const negativo = t.startsWith("-");
  const soDigitos = t.replace(/[^\d.,]/g, "");
  const ultimoSep = Math.max(soDigitos.lastIndexOf(","), soDigitos.lastIndexOf("."));
  let inteiro, decimal;
  if (ultimoSep === -1 || soDigitos.length - ultimoSep - 1 === 3) {
    // sem separador decimal (o último separador é de milhar)
    inteiro = soDigitos.replace(/[.,]/g, "");
    decimal = "00";
  } else {
    inteiro = soDigitos.slice(0, ultimoSep).replace(/[.,]/g, "");
    decimal = soDigitos.slice(ultimoSep + 1).padEnd(2, "0").slice(0, 2);
  }
  const centavos = Number(inteiro || "0") * 100 + Number(decimal);
  return negativo ? -centavos : centavos;
}

// ---------- Relatório de importação ----------

function novoRelatorio() {
  // motivos: linhas descartadas; problemas: linhas mantidas com ressalva
  return { motivos: {}, problemas: {}, avisos: [] };
}

function registrarOcorrencia(grupo, chave, amostra) {
  const item = (grupo[chave] ??= { qtde: 0, amostras: [] });
  item.qtde++;
  if (amostra !== undefined && item.amostras.length < AMOSTRAS_MAX) {
    item.amostras.push(String(amostra).slice(0, 200));
  }
}

function avisarSeReimportacao(relatorio, hash) {
  const anterior = db
    .prepare(
      `SELECT id, arquivo_nome, iniciado_em FROM importacoes
       WHERE hash_sha256 = ? AND status = 'concluida' ORDER BY id DESC LIMIT 1`
    )
    .get(hash);
  if (anterior) {
    relatorio.avisos.push(
      `Este mesmo conteúdo já foi importado em ${anterior.iniciado_em} ` +
        `(importação #${anterior.id}, arquivo "${anterior.arquivo_nome}"). ` +
        `Reimportar é seguro: nada será duplicado.`
    );
  }
}

function registrarImportacaoErro(tipo, arquivoNome, hash, usuarioId, iniciadoEm, erro) {
  const info = db
    .prepare(
      `INSERT INTO importacoes (tipo, arquivo_nome, hash_sha256, usuario_id,
        iniciado_em, concluido_em, status, erro)
       VALUES (?, ?, ?, ?, ?, ?, 'erro', ?)`
    )
    .run(tipo, arquivoNome, hash, usuarioId, iniciadoEm, new Date().toISOString(), String(erro));
  return { importacaoId: info.lastInsertRowid, status: "erro", erro: String(erro) };
}

// ---------- Resolução de colunas ----------

// Acha a chave real do registro para cada campo esperado, a partir de listas
// de candidatos (nomes já normalizados).
function resolverColunas(linhaExemplo, candidatosPorCampo, relatorio) {
  const chaves = Object.keys(linhaExemplo || {});
  const mapa = {};
  for (const [campo, candidatos] of Object.entries(candidatosPorCampo)) {
    mapa[campo] =
      chaves.find((c) => candidatos.includes(c)) ??
      chaves.find((c) => candidatos.some((cand) => c.includes(cand))) ??
      null;
    if (!mapa[campo]) {
      relatorio.avisos.push(`Coluna "${campo}" não encontrada no arquivo (cabeçalhos: ${chaves.join(", ")}).`);
    }
  }
  return mapa;
}

const valor = (linha, chave) => (chave ? String(linha[chave] ?? "").trim() : "");

// ---------- CDR do PABX ----------

const COLUNAS_CDR = {
  id: ["id"],
  hora: ["hora"],
  evento: ["evento"],
  numero_a: ["no a", "n a", "numero a"],
  numero_b: ["no b", "n b", "numero b"],
  ramal: ["ramal"],
  sentido: ["sentido"],
  duracao: ["duracao"],
  fila: ["fila"],
  gravacao: ["gravacao"],
};

function importarCdr(textoBruto, arquivoNome, usuarioId) {
  const iniciadoEm = new Date().toISOString();
  const texto = removerBom(textoBruto);
  const hash = hashSha256(texto);
  const relatorio = novoRelatorio();

  let linhas;
  try {
    linhas = lerCsv(texto);
  } catch (err) {
    return registrarImportacaoErro("cdr", arquivoNome, hash, usuarioId, iniciadoEm,
      `Arquivo ilegível como CSV: ${err.message}`);
  }
  if (linhas.length === 0) {
    return registrarImportacaoErro("cdr", arquivoNome, hash, usuarioId, iniciadoEm,
      "Arquivo vazio (nenhuma linha de dados).");
  }

  avisarSeReimportacao(relatorio, hash);
  const col = resolverColunas(linhas[0], COLUNAS_CDR, relatorio);

  const pessoaPorRamal = new Map(
    db.prepare("SELECT id, ramal FROM pessoas WHERE ramal IS NOT NULL").all()
      .map((p) => [p.ramal, p.id])
  );

  // Agrupa eventos por ID de ligação: max(duração), menor HORA, demais campos
  // do primeiro evento.
  const grupos = new Map();
  let lidas = 0;
  let ignoradas = 0;

  for (const linha of linhas) {
    lidas++;
    const cdrId = valor(linha, col.id);
    if (!cdrId) {
      ignoradas++;
      registrarOcorrencia(relatorio.motivos, "sem_id", JSON.stringify(linha).slice(0, 200));
      continue;
    }
    // Rodapé "DURAÇÃO: HH:MM:SS" quando cai na primeira coluna
    if (/^dura/i.test(normalizarNome(cdrId))) {
      ignoradas++;
      registrarOcorrencia(relatorio.motivos, "rodape", cdrId);
      continue;
    }

    let grupo = grupos.get(cdrId);
    if (!grupo) {
      grupo = { primeiro: linha, eventos: 0, duracaoSeg: 0, dataHora: null };
      grupos.set(cdrId, grupo);
    }
    grupo.eventos++;

    const bruto = valor(linha, col.duracao);
    const seg = duracaoParaSegundos(bruto);
    if (seg === null) {
      if (bruto) registrarOcorrencia(relatorio.problemas, "duracao_invalida", `${cdrId}: "${bruto}"`);
    } else {
      grupo.duracaoSeg = Math.max(grupo.duracaoSeg, seg);
    }

    const hora = dataHoraLocalIso(valor(linha, col.hora));
    if (hora === null && valor(linha, col.hora)) {
      registrarOcorrencia(relatorio.problemas, "hora_invalida", `${cdrId}: "${valor(linha, col.hora)}"`);
    } else if (hora && (!grupo.dataHora || hora < grupo.dataHora)) {
      grupo.dataHora = hora;
    }
  }

  const upsert = db.prepare(
    `INSERT INTO ligacoes (cdr_id, data_hora, ramal, pessoa_id, numero_a, numero_b,
       sentido, fila, duracao_seg, atendida, eventos, gravacao, importacao_id)
     VALUES (@cdr_id, @data_hora, @ramal, @pessoa_id, @numero_a, @numero_b,
       @sentido, @fila, @duracao_seg, @atendida, @eventos, @gravacao, @importacao_id)
     ON CONFLICT(cdr_id) DO UPDATE SET
       data_hora = excluded.data_hora, ramal = excluded.ramal,
       pessoa_id = excluded.pessoa_id, numero_a = excluded.numero_a,
       numero_b = excluded.numero_b, sentido = excluded.sentido,
       fila = excluded.fila, duracao_seg = excluded.duracao_seg,
       atendida = excluded.atendida, eventos = excluded.eventos,
       gravacao = excluded.gravacao, importacao_id = excluded.importacao_id`
  );
  const existe = db.prepare("SELECT 1 FROM ligacoes WHERE cdr_id = ?");

  try {
    const resultado = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO importacoes (tipo, arquivo_nome, hash_sha256, usuario_id, iniciado_em)
           VALUES ('cdr', ?, ?, ?, ?)`
        )
        .run(arquivoNome, hash, usuarioId, iniciadoEm);
      const importacaoId = info.lastInsertRowid;

      let novos = 0;
      let atualizados = 0;
      for (const [cdrId, grupo] of grupos) {
        const linha = grupo.primeiro;
        const ramal = valor(linha, col.ramal);
        const pessoaId = pessoaPorRamal.get(ramal) ?? null;
        if (ramal && pessoaId === null) {
          registrarOcorrencia(relatorio.problemas, "ramal_desconhecido", `${ramal} (ligação ${cdrId})`);
        }
        if (existe.get(cdrId)) atualizados++;
        else novos++;
        upsert.run({
          cdr_id: cdrId,
          data_hora: grupo.dataHora,
          ramal: ramal || null,
          pessoa_id: pessoaId,
          numero_a: valor(linha, col.numero_a) || null,
          numero_b: valor(linha, col.numero_b) || null,
          sentido: valor(linha, col.sentido) || null,
          fila: valor(linha, col.fila) || null,
          duracao_seg: grupo.duracaoSeg,
          atendida: grupo.duracaoSeg > 0 ? 1 : 0,
          eventos: grupo.eventos,
          gravacao: valor(linha, col.gravacao) || null,
          importacao_id: importacaoId,
        });
      }

      db.prepare(
        `UPDATE importacoes SET linhas_lidas = ?, linhas_validas = ?, linhas_ignoradas = ?,
           registros_novos = ?, registros_atualizados = ?, detalhes_json = ?, concluido_em = ?
         WHERE id = ?`
      ).run(lidas, lidas - ignoradas, ignoradas, novos, atualizados,
        JSON.stringify(relatorio), new Date().toISOString(), importacaoId);

      return { importacaoId, novos, atualizados };
    })();

    return {
      status: "concluida",
      importacaoId: resultado.importacaoId,
      tipo: "cdr",
      arquivo: arquivoNome,
      linhasLidas: lidas,
      linhasValidas: lidas - ignoradas,
      linhasIgnoradas: ignoradas,
      ligacoes: grupos.size,
      registrosNovos: resultado.novos,
      registrosAtualizados: resultado.atualizados,
      detalhes: relatorio,
    };
  } catch (err) {
    return registrarImportacaoErro("cdr", arquivoNome, hash, usuarioId, iniciadoEm,
      `Falha ao gravar no banco: ${err.message}`);
  }
}

// ---------- Oportunidades do Omie (.xlsx) ----------
// Planilha "Planilha de Oportunidades": título na linha 1, cabeçalho na 2.
// "N/D" é o nulo do Omie. Cada exportação é um retrato de janela recente —
// o upsert por "Número" insere/atualiza e NUNCA apaga o que não veio no
// arquivo (o banco é a união de todas as importações). Mudanças de fase,
// status, motivo e ticket entre importações vão para oportunidade_mudancas.

// Cabeçalhos (normalizados) → campo. "Data de -" e "Data de --" são as fases
// 04 e 05, que vêm sem nome no arquivo.
const COLUNAS_OMIE = {
  numero: ["numero"],
  conta: ["conta"],
  cnpj_cpf: ["cnpj/cpf da conta", "cnpj/cpf"],
  solucao: ["solucao"],
  titulo: ["oportunidade"],
  contato: ["contato"],
  vendedor: ["vendedor"],
  tipo_cliente: ["tipo"],
  fase_atual: ["fase atual"],
  status: ["status"],
  motivo_conclusao: ["motivo de conclusao"],
  fase_01_em: ["data de 01_lead novo"],
  fase_02_em: ["data de 02_qualificacao"],
  fase_03_em: ["data de 03_negociacao"],
  fase_04_em: ["data de -"],
  fase_05_em: ["data de --"],
  fase_06_em: ["data de 06_conclusao"],
  produtos_centavos: ["produtos"],
  servicos_centavos: ["servicos"],
  recorrencia_centavos: ["recorrencia"],
  meses: ["meses"],
  ticket_centavos: ["ticket calculado"],
  temperatura: ["temperatura"],
  origem: ["origem"],
  vertical: ["vertical"],
  telefone: ["telefone"],
  celular_1: ["celular 1"],
  celular_2: ["celular 2"],
  email: ["email"],
  incluido_em: ["data de inclusao"],
  atualizado_em: ["data de atualizacao"],
};

const FASES_CONHECIDAS = new Set([
  "01_lead novo", "02_qualificacao", "03_negociacao", "06_conclusao",
]);
const STATUS_CONHECIDOS = new Set(["ativo", "perdido", "conquistado"]);

// Campos cuja mudança entre importações vira linha em oportunidade_mudancas
const CAMPOS_RASTREADOS = ["fase_atual", "status", "motivo_conclusao", "ticket_centavos"];

// "YYYY-MM-DDTHH:MM:SS" no fuso local (mesma convenção dos dados operacionais)
function agoraLocalIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Valor cru de célula do exceljs → primitivo (texto/número/Date) ou null.
// "N/D" é o nulo do Omie. Hyperlink/rich text/fórmula viram o texto/resultado.
function valorCelula(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if (v.richText) return valorCelula(v.richText.map((t) => t.text).join(""));
    if (v.text !== undefined) return valorCelula(v.text);
    if (v.result !== undefined) return valorCelula(v.result);
    return null;
  }
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t.toUpperCase() === "N/D" ? null : t;
  }
  return v;
}

// Data de célula → ISO local. O exceljs devolve Date ancorado em UTC, então o
// dia literal da planilha sai pelos getters UTC (sem deslocamento de fuso).
// Fallbacks: número serial do Excel e texto "DD/MM/YYYY[ HH:MM[:SS]]"/ISO.
function dataCelulaIso(v) {
  if (v === null) return null;
  if (typeof v === "number" && v > 0) {
    v = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
  }
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    const p = (n) => String(n).padStart(2, "0");
    const dia = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
    const temHora = v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds();
    return temHora
      ? `${dia}T${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}`
      : dia;
  }
  const t = String(v).trim();
  const comHora = dataHoraLocalIso(t);
  if (comHora) return comHora;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return t;
  return null;
}

// Reais → centavos: célula numérica multiplica direto; texto usa o parser do CSV
function centavosCelula(v) {
  if (v === null) return null;
  if (typeof v === "number") return Math.round(v * 100);
  return dinheiroParaCentavos(v);
}

function inteiroCelula(v) {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizarTelefone(v) {
  if (v === null) return null;
  const digitos = String(v).replace(/\D/g, "");
  return digitos || null;
}

// Compara o registro canônico novo com a linha do banco (as datas de fase usam
// o valor pós-COALESCE — data conhecida nunca regride a NULL no UPDATE).
function registroIdentico(existente, novo) {
  for (const campo of Object.keys(novo)) {
    if (campo === "numero" || campo === "importacao_id") continue;
    let valorNovo = novo[campo];
    if (campo.startsWith("fase_") && campo.endsWith("_em")) {
      valorNovo = valorNovo ?? existente[campo];
    }
    if ((valorNovo ?? null) !== (existente[campo] ?? null)) return false;
  }
  return true;
}

async function importarOportunidadesOmie(buffer, arquivoNome, usuarioId) {
  const iniciadoEm = new Date().toISOString();
  const hash = hashSha256(buffer);
  const relatorio = novoRelatorio();

  let planilha;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    planilha = workbook.getWorksheet("Planilha de Oportunidades");
    if (!planilha) {
      planilha = workbook.worksheets[0];
      if (!planilha) throw new Error("o arquivo não tem nenhuma aba");
      relatorio.avisos.push(
        `Aba "Planilha de Oportunidades" não encontrada — usando a primeira aba ("${planilha.name}").`
      );
    }
  } catch (err) {
    return registrarImportacaoErro("oportunidades", arquivoNome, hash, usuarioId,
      iniciadoEm, `Arquivo ilegível como .xlsx: ${err.message}`);
  }

  // Cabeçalho: primeira das 5 primeiras linhas com "Número" e "Fase Atual"
  // (a linha 1 do Omie é o título da planilha)
  let linhaCabecalho = 0;
  let cabecalhos = []; // índice de coluna (1-based) → nome normalizado
  for (let r = 1; r <= Math.min(5, planilha.rowCount); r++) {
    const nomes = planilha.getRow(r).values.map((c) => normalizarNome(valorCelula(c) ?? ""));
    if (nomes.includes("numero") && nomes.includes("fase atual")) {
      linhaCabecalho = r;
      cabecalhos = nomes;
      break;
    }
  }
  if (!linhaCabecalho) {
    return registrarImportacaoErro("oportunidades", arquivoNome, hash, usuarioId, iniciadoEm,
      'Cabeçalho não encontrado: nenhuma das 5 primeiras linhas tem as colunas "Número" e "Fase Atual".');
  }

  avisarSeReimportacao(relatorio, hash);

  // campo → índice de coluna (match exato do nome normalizado, com fallback
  // por inclusão para tolerar variações)
  const col = {};
  for (const [campo, candidatos] of Object.entries(COLUNAS_OMIE)) {
    let idx = cabecalhos.findIndex((c) => candidatos.includes(c));
    if (idx === -1) idx = cabecalhos.findIndex((c) => c && candidatos.some((cand) => c.includes(cand)));
    col[campo] = idx === -1 ? null : idx;
    if (col[campo] === null) {
      relatorio.avisos.push(`Coluna "${campo}" não encontrada no arquivo.`);
    }
  }
  // Colunas que sobraram (Previsão, Finder, Aging…) são preservadas em extras_json
  const indicesMapeados = new Set(Object.values(col).filter((i) => i !== null));
  const colunasExtras = [];
  const rotuloOriginal = planilha.getRow(linhaCabecalho).values;
  for (let i = 1; i < cabecalhos.length; i++) {
    if (cabecalhos[i] && !indicesMapeados.has(i)) {
      colunasExtras.push({ idx: i, rotulo: String(valorCelula(rotuloOriginal[i]) ?? cabecalhos[i]) });
    }
  }

  const pessoas = db.prepare("SELECT id, nome, nomes_alternativos FROM pessoas").all();
  const pessoaPorNome = new Map();
  for (const p of pessoas) {
    pessoaPorNome.set(normalizarNome(p.nome), p.id);
    for (const alt of JSON.parse(p.nomes_alternativos || "[]")) {
      pessoaPorNome.set(normalizarNome(alt), p.id);
    }
  }

  const buscarExistente = db.prepare("SELECT * FROM oportunidades WHERE numero = ?");
  const inserir = db.prepare(
    `INSERT INTO oportunidades (numero, conta, cnpj_cpf, solucao, titulo, contato,
       vendedor, pessoa_id, tipo_cliente, fase_atual, status, motivo_conclusao,
       fase_01_em, fase_02_em, fase_03_em, fase_04_em, fase_05_em, fase_06_em,
       produtos_centavos, servicos_centavos, recorrencia_centavos, meses,
       ticket_centavos, temperatura, origem, vertical, telefone, celular_1,
       celular_2, email, incluido_em, atualizado_em, extras_json, importacao_id)
     VALUES (@numero, @conta, @cnpj_cpf, @solucao, @titulo, @contato, @vendedor,
       @pessoa_id, @tipo_cliente, @fase_atual, @status, @motivo_conclusao,
       @fase_01_em, @fase_02_em, @fase_03_em, @fase_04_em, @fase_05_em, @fase_06_em,
       @produtos_centavos, @servicos_centavos, @recorrencia_centavos, @meses,
       @ticket_centavos, @temperatura, @origem, @vertical, @telefone, @celular_1,
       @celular_2, @email, @incluido_em, @atualizado_em, @extras_json, @importacao_id)`
  );
  const atualizar = db.prepare(
    `UPDATE oportunidades SET conta = @conta, cnpj_cpf = @cnpj_cpf,
       solucao = @solucao, titulo = @titulo, contato = @contato,
       vendedor = @vendedor, pessoa_id = @pessoa_id, tipo_cliente = @tipo_cliente,
       fase_atual = @fase_atual, status = @status, motivo_conclusao = @motivo_conclusao,
       fase_01_em = COALESCE(@fase_01_em, fase_01_em),
       fase_02_em = COALESCE(@fase_02_em, fase_02_em),
       fase_03_em = COALESCE(@fase_03_em, fase_03_em),
       fase_04_em = COALESCE(@fase_04_em, fase_04_em),
       fase_05_em = COALESCE(@fase_05_em, fase_05_em),
       fase_06_em = COALESCE(@fase_06_em, fase_06_em),
       produtos_centavos = @produtos_centavos, servicos_centavos = @servicos_centavos,
       recorrencia_centavos = @recorrencia_centavos, meses = @meses,
       ticket_centavos = @ticket_centavos, temperatura = @temperatura,
       origem = @origem, vertical = @vertical, telefone = @telefone,
       celular_1 = @celular_1, celular_2 = @celular_2, email = @email,
       incluido_em = @incluido_em, atualizado_em = @atualizado_em,
       extras_json = @extras_json, importacao_id = @importacao_id
     WHERE numero = @numero`
  );
  const gravarMudanca = db.prepare(
    `INSERT INTO oportunidade_mudancas (oportunidade_id, campo, valor_anterior,
       valor_novo, observado_em, importacao_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let lidas = 0;
  let ignoradas = 0;
  let periodoDe = null;
  let periodoAte = null;

  try {
    const resultado = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO importacoes (tipo, arquivo_nome, hash_sha256, usuario_id, iniciado_em)
           VALUES ('oportunidades', ?, ?, ?, ?)`
        )
        .run(arquivoNome, hash, usuarioId, iniciadoEm);
      const importacaoId = info.lastInsertRowid;
      const observadoEm = agoraLocalIso();

      let novos = 0;
      let atualizados = 0;
      let identicos = 0;

      for (let r = linhaCabecalho + 1; r <= planilha.rowCount; r++) {
        const valores = planilha.getRow(r).values;
        if (!valores.some((v) => valorCelula(v) !== null)) continue; // linha vazia
        lidas++;

        const cel = (campo) => (col[campo] === null ? null : valorCelula(valores[col[campo]]));
        const texto = (campo) => {
          const v = cel(campo);
          return v === null ? null : String(v).trim();
        };

        const numero = texto("numero");
        if (!numero) {
          ignoradas++;
          registrarOcorrencia(relatorio.motivos, "sem_numero",
            valores.map((v) => valorCelula(v)).filter((v) => v !== null).join(" | "));
          continue;
        }

        const faseAtual = texto("fase_atual");
        if (faseAtual && !FASES_CONHECIDAS.has(normalizarNome(faseAtual))) {
          registrarOcorrencia(relatorio.problemas, "fase_desconhecida", `${numero}: "${faseAtual}"`);
        }
        const status = texto("status");
        if (status && !STATUS_CONHECIDOS.has(normalizarNome(status))) {
          registrarOcorrencia(relatorio.problemas, "status_desconhecido", `${numero}: "${status}"`);
        }

        const vendedor = texto("vendedor");
        const pessoaId = vendedor ? (pessoaPorNome.get(normalizarNome(vendedor)) ?? null) : null;
        if (vendedor && pessoaId === null) {
          registrarOcorrencia(relatorio.problemas, "vendedor_sem_match", `${numero}: "${vendedor}"`);
        }

        const extras = {};
        for (const { idx, rotulo } of colunasExtras) {
          const v = valorCelula(valores[idx]);
          if (v !== null) extras[rotulo] = v instanceof Date ? dataCelulaIso(v) : v;
        }

        const registro = {
          numero,
          conta: texto("conta"),
          cnpj_cpf: texto("cnpj_cpf"),
          solucao: texto("solucao"),
          titulo: texto("titulo"),
          contato: texto("contato"),
          vendedor,
          pessoa_id: pessoaId,
          tipo_cliente: texto("tipo_cliente"),
          fase_atual: faseAtual,
          status,
          motivo_conclusao: texto("motivo_conclusao"),
          fase_01_em: dataCelulaIso(cel("fase_01_em")),
          fase_02_em: dataCelulaIso(cel("fase_02_em")),
          fase_03_em: dataCelulaIso(cel("fase_03_em")),
          fase_04_em: dataCelulaIso(cel("fase_04_em")),
          fase_05_em: dataCelulaIso(cel("fase_05_em")),
          fase_06_em: dataCelulaIso(cel("fase_06_em")),
          produtos_centavos: centavosCelula(cel("produtos_centavos")),
          servicos_centavos: centavosCelula(cel("servicos_centavos")),
          recorrencia_centavos: centavosCelula(cel("recorrencia_centavos")),
          meses: inteiroCelula(cel("meses")),
          ticket_centavos: centavosCelula(cel("ticket_centavos")),
          temperatura: inteiroCelula(cel("temperatura")),
          origem: texto("origem"),
          vertical: texto("vertical"),
          telefone: normalizarTelefone(cel("telefone")),
          celular_1: normalizarTelefone(cel("celular_1")),
          celular_2: normalizarTelefone(cel("celular_2")),
          email: texto("email")?.toLowerCase() ?? null,
          incluido_em: dataCelulaIso(cel("incluido_em")),
          atualizado_em: dataCelulaIso(cel("atualizado_em")),
          extras_json: Object.keys(extras).length ? JSON.stringify(extras) : null,
          importacao_id: importacaoId,
        };

        if (registro.incluido_em) {
          if (!periodoDe || registro.incluido_em < periodoDe) periodoDe = registro.incluido_em;
          if (!periodoAte || registro.incluido_em > periodoAte) periodoAte = registro.incluido_em;
        }

        const existente = buscarExistente.get(numero);
        if (!existente) {
          novos++;
          inserir.run(registro);
        } else if (registroIdentico(existente, registro)) {
          identicos++; // nada a gravar — nem histórico
        } else {
          atualizados++;
          for (const campo of CAMPOS_RASTREADOS) {
            if ((registro[campo] ?? null) !== (existente[campo] ?? null)) {
              gravarMudanca.run(existente.id, campo,
                existente[campo] === null ? null : String(existente[campo]),
                registro[campo] === null ? null : String(registro[campo]),
                observadoEm, importacaoId);
            }
          }
          atualizar.run(registro);
        }
      }

      relatorio.periodo = { de: periodoDe, ate: periodoAte };
      db.prepare(
        `UPDATE importacoes SET linhas_lidas = ?, linhas_validas = ?, linhas_ignoradas = ?,
           registros_novos = ?, registros_atualizados = ?, registros_identicos = ?,
           detalhes_json = ?, concluido_em = ?
         WHERE id = ?`
      ).run(lidas, lidas - ignoradas, ignoradas, novos, atualizados, identicos,
        JSON.stringify(relatorio), new Date().toISOString(), importacaoId);

      return { importacaoId, novos, atualizados, identicos };
    })();

    return {
      status: "concluida",
      importacaoId: resultado.importacaoId,
      tipo: "oportunidades",
      arquivo: arquivoNome,
      linhasLidas: lidas,
      linhasValidas: lidas - ignoradas,
      linhasIgnoradas: ignoradas,
      registrosNovos: resultado.novos,
      registrosAtualizados: resultado.atualizados,
      registrosIdenticos: resultado.identicos,
      periodo: { de: periodoDe, ate: periodoAte },
      detalhes: relatorio,
    };
  } catch (err) {
    return registrarImportacaoErro("oportunidades", arquivoNome, hash, usuarioId,
      iniciadoEm, `Falha ao gravar no banco: ${err.message}`);
  }
}

module.exports = {
  importarCdr,
  importarOportunidadesOmie,
  // utilitários exportados para os demais importadores/testes
  removerBom,
  hashSha256,
  normalizarNome,
  lerCsv,
  duracaoParaSegundos,
  dataHoraLocalIso,
  dinheiroParaCentavos,
  normalizarTelefone,
  dataCelulaIso,
};
