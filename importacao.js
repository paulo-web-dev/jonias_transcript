"use strict";

// Ingestão de arquivos da central de dados (CDR do PABX e oportunidades do
// Ramper). Toda importação é idempotente (upsert pela chave natural), nunca
// aborta por linha ruim (linhas problemáticas viram relatório) e registra
// auditoria completa na tabela importacoes.

const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const db = require("./db.js");

const AMOSTRAS_MAX = 20;

// ---------- Utilitários de texto/CSV ----------

function removerBom(texto) {
  const t = String(texto || "");
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t; // BOM do utf-8-sig
}

function hashSha256(texto) {
  return crypto.createHash("sha256").update(texto, "utf8").digest("hex");
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

module.exports = {
  importarCdr,
  // utilitários exportados para os demais importadores/testes
  removerBom,
  hashSha256,
  normalizarNome,
  lerCsv,
  duracaoParaSegundos,
  dataHoraLocalIso,
  dinheiroParaCentavos,
};
